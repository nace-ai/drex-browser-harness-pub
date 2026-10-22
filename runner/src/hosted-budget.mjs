// The hosted wallet boundary lives outside Chromium. Every physical provider
// request, retry and second of sandbox lifetime shares integer nano-USD here.
// The local CLI's optional extension budget remains a separate convenience.
export class HostedBudget {
  constructor(funding, { now = Date.now } = {}) {
    this.now = now;
    this.start = funding.started_at_ms;
    this.expires = funding.expires_at_ms;
    this.maximum = BigInt(funding.budget_nusd);
    this.prices = Object.fromEntries(Object.entries(funding.prices).map(([k, v]) => [k, BigInt(v)]));
    this.spent = 0n;
    this.exhausted = false;
    this.held = 0n;
    this.usage = { drex_input_tokens: 0, llm_input_tokens: 0, llm_output_tokens: 0 };
    this.controller = new AbortController();
    this.timer = null;
    this.arm();
  }

  get signal() {
    return this.controller.signal;
  }
  get elapsed() {
    return BigInt(Math.max(0, Math.ceil((this.now() - this.start) / 1000)));
  }

  stop(exhausted = true) {
    if (this.signal.aborted) return;
    this.exhausted = exhausted;
    this.controller.abort(new Error(exhausted ? "Funded browser budget exhausted." : "Provider outcome is unknown."));
    clearTimeout(this.timer);
  }

  arm() {
    clearTimeout(this.timer);
    if (this.signal.aborted) return;
    const left = this.maximum - this.spent - this.held;
    const end = Math.min(
      this.expires,
      this.prices.browser_second === 0n ? this.expires : this.start + Number(left / this.prices.browser_second) * 1000,
    );
    if (end <= this.now()) {
      this.stop();
      return;
    }
    this.timer = setTimeout(() => this.stop(), Math.min(end - this.now(), 2147483647));
  }

  reserve(kind, body) {
    this.signal.throwIfAborted();
    let bound;
    if (kind === "drex") {
      const questions = Object.keys(body.questions ?? {}).length;
      if (!questions || body.model !== "drex-max") throw new Error("Unsupported funded Drex request.");
      // Drex Max enforces 262,144 tokens per question, including images.
      bound = 262144n * BigInt(questions) * this.prices.drex_input;
    } else {
      if (!Number.isSafeInteger(body.max_tokens) || body.max_tokens < 1 || body.max_tokens > 4096)
        throw new Error("Unbounded funded LLM output.");
      bound = BigInt(inputBound(body)) * this.prices.llm_input + BigInt(body.max_tokens) * this.prices.llm_output;
    }
    if (this.spent + this.held + bound + this.elapsed * this.prices.browser_second >= this.maximum) {
      this.stop();
      this.signal.throwIfAborted();
    }
    this.held += bound;
    this.arm();
    this.signal.throwIfAborted();
    return { kind, bound, settled: false };
  }

  settle(ticket, usage) {
    if (ticket.settled) throw new Error("Duplicate provider settlement.");
    ticket.settled = true;
    if (usage === null) {
      // An ambiguous network result is not a free retry. Retain its liability
      // and stop the run; Drex releases the wallet only after terminal cleanup.
      this.stop(false);
      return;
    }
    const input = usage.input,
      output = usage.output;
    if (![input, output].every((n) => Number.isSafeInteger(n) && n >= 0)) {
      this.stop(false);
      return;
    }
    const cost =
      ticket.kind === "drex"
        ? BigInt(input) * this.prices.drex_input
        : BigInt(input) * this.prices.llm_input + BigInt(output) * this.prices.llm_output;
    this.held -= ticket.bound;
    this.spent += cost;
    if (ticket.kind === "drex") this.usage.drex_input_tokens += input;
    else {
      this.usage.llm_input_tokens += input;
      this.usage.llm_output_tokens += output;
    }
    if (cost > ticket.bound) this.stop();
    else this.arm();
  }

  dispose() {
    clearTimeout(this.timer);
  }
}

// A byte-level tokenizer cannot create more text tokens than UTF-8 bytes.
// Images are bounded by decoded pixels, using the conservative cross-provider
// patch bound also used by the extension (providers.ts), never base64 length.
function inputBound(body) {
  let imageTokens = 0;
  const text = JSON.stringify(body, (key, value) => {
    if (key !== "source" || value?.type !== "base64") return value;
    const bytes = Buffer.from(value.data, "base64");
    let width, height;
    if (
      value.media_type === "image/png" &&
      bytes.length >= 24 &&
      bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    ) {
      width = bytes.readUInt32BE(16);
      height = bytes.readUInt32BE(20);
    } else if (value.media_type === "image/jpeg" && bytes[0] === 255 && bytes[1] === 216) {
      for (let i = 2; i + 9 < bytes.length;) {
        if (bytes[i] !== 255) break;
        const marker = bytes[i + 1];
        if (marker >= 192 && marker <= 207 && ![196, 200, 204].includes(marker)) {
          height = bytes.readUInt16BE(i + 5);
          width = bytes.readUInt16BE(i + 7);
          break;
        }
        const length = bytes.readUInt16BE(i + 2);
        if (length < 2) break;
        i += 2 + length;
      }
    }
    if (!width || !height || width > 20000 || height > 20000) throw new Error("Unbounded funded image.");
    imageTokens += Math.ceil(Math.ceil(width / 32) * Math.ceil(height / 32) * 2.46 + 2240);
    return { type: "image" };
  });
  return Buffer.byteLength(text, "utf8") + 4096 + imageTokens;
}

/** Read complete JSON or Anthropic SSE usage; absent/truncated usage is unknown. */
export function providerUsage(kind, body) {
  try {
    if (kind === "drex") {
      const value = JSON.parse(body);
      return { input: value.usage.input_tokens, output: 0 };
    }
    let input = null,
      output = null;
    const json = body.trim().startsWith("{");
    const values = json
      ? [JSON.parse(body)]
      : body
          .split("\n")
          .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
          .map((line) => JSON.parse(line.slice(6)));
    // A clean HTTP EOF can still be a truncated SSE message. Never release
    // its reservation from the initial message_start usage alone.
    if (!json && !values.some((v) => v.type === "message_stop")) return null;
    if (json && !values[0].stop_reason) return null;
    for (const value of values) {
      const usage = value.message?.usage ?? value.usage;
      if (!usage) continue;
      if (Number.isSafeInteger(usage.input_tokens))
        input = usage.input_tokens + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
      if (Number.isSafeInteger(usage.output_tokens)) output = usage.output_tokens;
    }
    return input === null || output === null ? null : { input, output };
  } catch {
    return null;
  }
}
