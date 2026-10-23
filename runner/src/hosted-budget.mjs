// The hosted wallet boundary lives outside Chromium. Every physical provider
// request, retry and second of sandbox lifetime shares integer nano-USD here.
// The local CLI's optional extension budget remains a separate convenience.

// sandbox seconds kept back from the grant for what follows a stop: closing Chromium, removing the run's files and
// signing and sending the report
export const CLEANUP_SECONDS = 10;

// the top-level fields of a funded LLM request (those the extension's Anthropic client sends)
const LLM_FIELDS = new Set([
  "model",
  "max_tokens",
  "system",
  "messages",
  "tools",
  "tool_choice",
  "thinking",
  "output_config",
  "temperature",
  "top_k",
  "top_p",
  "stop_sequences",
  "stream",
]);

export class HostedBudget {
  constructor(funding, { now = Date.now, cleanupSeconds = CLEANUP_SECONDS, llmModel } = {}) {
    // Wall-clock corrections must not give a running sandbox more funded time.
    const monotonicStart = performance.now();
    const wallStart = Math.max(now(), funding.started_at_ms);
    let last = wallStart;
    this.now = () => (last = Math.max(last, now(), wallStart + performance.now() - monotonicStart));
    // the model the pinned LLM prices are for: a funded call to any other model is refused
    this.llmModel = llmModel;
    this.start = funding.started_at_ms;
    this.expires = funding.expires_at_ms;
    this.maximum = BigInt(funding.budget_nusd);
    this.prices = Object.fromEntries(Object.entries(funding.prices).map(([k, v]) => [k, BigInt(v)]));
    this.cleanup = BigInt(cleanupSeconds);
    this.reserved = this.cleanup * this.prices.browser_second;
    this.spent = 0n;
    this.exhausted = false;
    this.held = 0n;
    this.usage = { drex_input_tokens: 0, llm_input_tokens: 0, llm_output_tokens: 0 };
    this.controller = new AbortController();
    this.timer = null;
    this.cleaning = false;
    // A start in the future reveals clock skew; do not grant unmetered time.
    if (now() < this.start) this.stop();
    else this.arm();
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

  /** When the funds and the grant run out, keeping cleanup seconds back (0n: the whole funded lifetime, reserve included). */
  until(cleanup = this.cleanup) {
    const left = this.maximum - this.spent - this.held - cleanup * this.prices.browser_second;
    const expires = this.expires - Number(cleanup) * 1000;
    return Math.min(
      expires,
      this.prices.browser_second === 0n ? expires : this.start + Number(left / this.prices.browser_second) * 1000,
    );
  }

  arm() {
    clearTimeout(this.timer);
    if (this.signal.aborted) return;
    const end = this.until(this.cleaning ? 0n : this.cleanup);
    if (end <= this.now()) {
      this.stop();
      return;
    }
    this.timer = setTimeout(() => this.stop(), Math.min(end - this.now(), 2147483647));
  }

  beginCleanup() {
    this.cleaning = true;
    if (this.held > 0n) this.stop(false);
    // Cleanup can use its reserved seconds, but never extend the funded grant.
    this.arm();
  }

  reserve(kind, body) {
    this.signal.throwIfAborted();
    if (this.cleaning) throw new Error("Funded provider work has ended.");
    let bound;
    if (kind === "drex") {
      const questions = Object.keys(body.questions ?? {}).length;
      if (!questions || body.model !== "drex-max") throw new Error("Unsupported funded Drex request.");
      // Drex Max enforces 262,144 tokens per question, including images.
      bound = 262144n * BigInt(questions) * this.prices.drex_input;
    } else {
      if (!Number.isSafeInteger(body.max_tokens) || body.max_tokens < 1 || body.max_tokens > 4096)
        throw new Error("Unbounded funded LLM output.");
      // Unknown fields may enable model fallbacks or extra provider passes; only the extension contract is funded.
      if (
        !this.llmModel ||
        body.model !== this.llmModel ||
        Object.keys(body).some((key) => !LLM_FIELDS.has(key)) ||
        (body.tools !== undefined &&
          (!Array.isArray(body.tools) || body.tools.some((t) => t?.type !== undefined && t?.type !== "custom")))
      )
        throw new Error("Unsupported funded LLM request.");
      bound = BigInt(inputBound(body)) * this.prices.llm_input + BigInt(body.max_tokens) * this.prices.llm_output;
    }
    if (this.spent + this.held + bound + this.elapsed * this.prices.browser_second + this.reserved >= this.maximum) {
      this.stop();
      this.signal.throwIfAborted();
    }
    this.held += bound;
    this.arm();
    if (this.signal.aborted) {
      // arm() stopped (the grant's end, not checked above): this call is never sent, so it holds nothing
      this.held -= bound;
      this.signal.throwIfAborted();
    }
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
  // only image blocks of a message's content (or a tool result's) are billed as images; a "source" anywhere else
  // (a tool call's input, a tool schema) is text, counted by its bytes
  const images = new Set();
  const collect = (content) => {
    if (Array.isArray(content)) for (const block of content) if (block?.type === "image") images.add(block);
  };
  for (const message of Array.isArray(body.messages) ? body.messages : []) {
    collect(message?.content);
    if (Array.isArray(message?.content))
      for (const block of message.content) if (block?.type === "tool_result") collect(block.content);
  }
  let imageTokens = 0;
  const text = JSON.stringify(body, function (key, value) {
    // a URL or uploaded file is billed by content the provider fetches, not by these bytes
    if (key === "source" && (value?.type === "url" || value?.type === "file"))
      throw new Error("Unbounded funded image.");
    // a PDF is billed per page, and a content document's images by pixels: neither is bounded by these bytes
    if (key === "source" && this?.type === "document" && value?.type !== "text")
      throw new Error("Unbounded funded document.");
    if (key !== "source" || value?.type !== "base64" || !images.has(this)) return value;
    const bytes = Buffer.from(value.data, "base64");
    let width, height;
    if (
      value.media_type === "image/png" &&
      bytes.length >= 24 &&
      bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
      // a decoder takes the size from IHDR, which must be the first chunk
      bytes.toString("latin1", 12, 16) === "IHDR"
    ) {
      width = bytes.readUInt32BE(16);
      height = bytes.readUInt32BE(20);
    } else if (value.media_type === "image/jpeg" && bytes[0] === 255 && bytes[1] === 216) {
      for (let i = 2; i + 9 < bytes.length;) {
        if (bytes[i] !== 255) break;
        const marker = bytes[i + 1];
        // walk markers as a decoder does: fill bytes and standalone markers carry no length, so reading one there
        // would jump to a different (possibly crafted) frame header than the one the provider decodes
        if (marker === 255) {
          i++;
          continue;
        }
        if (marker === 1 || (marker >= 208 && marker <= 215)) {
          i += 2;
          continue;
        }
        // a stuffed zero, a second start or an early end has no length: a decoder skips or rejects it, so refuse
        if (marker === 0 || marker === 216 || marker === 217) break;
        if (marker >= 192 && marker <= 207 && ![196, 200, 204].includes(marker)) {
          height = bytes.readUInt16BE(i + 5);
          width = bytes.readUInt16BE(i + 7);
          break;
        }
        const length = bytes.readUInt16BE(i + 2);
        if (length < 2) break;
        i += 2 + length;
      }
    } else if (
      value.media_type === "image/webp" &&
      bytes.length >= 30 &&
      bytes.toString("latin1", 0, 4) === "RIFF" &&
      bytes.toString("latin1", 8, 12) === "WEBP"
    ) {
      const chunk = bytes.toString("latin1", 12, 16);
      if (chunk === "VP8X") {
        width = bytes.readUIntLE(24, 3) + 1;
        height = bytes.readUIntLE(27, 3) + 1;
      } else if (chunk === "VP8L" && bytes[20] === 0x2f) {
        const bits = bytes.readUInt32LE(21);
        width = (bits & 0x3fff) + 1;
        height = ((bits >>> 14) & 0x3fff) + 1;
      } else if (chunk === "VP8 " && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
        width = bytes.readUInt16LE(26) & 0x3fff;
        height = bytes.readUInt16LE(28) & 0x3fff;
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
      cacheRead = 0,
      cacheCreation = 0,
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
    // Each usage counter is cumulative and may arrive in a different event, so merge them individually.
    for (const value of values) {
      const usage = value.message?.usage ?? value.usage;
      if (!usage) continue;
      if (Number.isSafeInteger(usage.input_tokens)) input = Math.max(input ?? 0, usage.input_tokens);
      if (Number.isSafeInteger(usage.cache_read_input_tokens))
        cacheRead = Math.max(cacheRead, usage.cache_read_input_tokens);
      if (Number.isSafeInteger(usage.cache_creation_input_tokens))
        cacheCreation = Math.max(cacheCreation, usage.cache_creation_input_tokens);
      // message_start output is only the initial count; the final total arrives in message_delta.
      if (Number.isSafeInteger(usage.output_tokens) && (json || value.type === "message_delta"))
        output = Math.max(output ?? 0, usage.output_tokens);
    }
    return input === null || output === null ? null : { input: input + cacheRead + cacheCreation, output };
  } catch {
    return null;
  }
}
