import test from "node:test";
import assert from "node:assert/strict";
import { APICallError } from "ai";
import { MockLanguageModelV4, convertArrayToReadableStream } from "ai/test";
import { callOptions, countInput, imageTokens, maxImageTokens, maxInputTokens, send } from "../src/providers.ts";

// a 4x2 PNG and a 640x400 JPEG header: only the size is read
const png = Buffer.from("89504e470d0a1a0a0000000d4948445200000004000000020806000000", "hex").toString("base64");
const jpeg = Buffer.concat([
  Buffer.from("ffd8ffe000104a46494600010100000100010000ffc0001108019002800301220002110103110100", "hex"),
]).toString("base64");
const request = (model, extra = {}) => ({
  model,
  max_tokens: 1500,
  system: [
    { type: "text", text: "Rules." },
    { type: "text", text: "Long cached instructions.", cache_control: { type: "ephemeral", ttl: "5m" } },
  ],
  messages: [
    {
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: "image/png", data: png } },
        { type: "text", text: '{"task":"Read"}' },
      ],
    },
  ],
  output_config: {
    effort: "low",
    format: {
      type: "json_schema",
      schema: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
        additionalProperties: false,
      },
    },
  },
  ...extra,
});

test("Anthropic gets its cache marks, native JSON output and its own effort setting, not the portable reasoning", () => {
  const o = callOptions(request("claude-haiku-5-5"), "anthropic");
  assert.deepEqual(o.instructions[1].providerOptions, {
    anthropic: { cacheControl: { type: "ephemeral", ttl: "5m" } },
  });
  assert.equal(o.instructions[0].providerOptions, undefined);
  assert.deepEqual(o.providerOptions, { anthropic: { structuredOutputMode: "outputFormat", effort: "low" } });
  assert.equal(o.reasoning, undefined);
  assert.equal(o.maxRetries, 0);
  assert.deepEqual(o.messages[0].content[0], { type: "file", data: png, mediaType: "image/png" });
});

test("OpenAI and Fireworks get the portable reasoning effort and no Anthropic options", () => {
  for (const [model, provider] of [
    ["gpt-5.4-mini", "openai"],
    ["accounts/fireworks/models/glm-5p3-flash", "fireworks"],
  ]) {
    const o = callOptions(request(model), provider);
    assert.equal(o.reasoning, "low");
    assert.equal(o.providerOptions, undefined);
    assert.equal(
      o.instructions.some((m) => m.providerOptions),
      false,
    );
  }
});

const streamOf = (text, finish = "stop") =>
  new MockLanguageModelV4({
    doStream: async (options) => {
      streamOf.seen = options;
      return {
        stream: convertArrayToReadableStream([
          { type: "text-start", id: "t" },
          { type: "text-delta", id: "t", delta: text },
          { type: "text-end", id: "t" },
          {
            type: "finish",
            finishReason: { unified: finish, raw: finish },
            usage: {
              inputTokens: { total: 1300, noCache: 100, cacheRead: 1000, cacheWrite: 200 },
              outputTokens: { total: 40, text: 40, reasoning: undefined },
            },
          },
        ]),
      };
    },
  });

test("send streams one call and answers in llm.js's shape, with cache reads and writes apart", async () => {
  const r = await send(request("claude-haiku-5-5"), { keys: {}, timeout: 5000, model: streamOf('{"text":"ok"}') });
  assert.deepEqual(r.content, [{ type: "text", text: '{"text":"ok"}' }]);
  assert.equal(r.stop_reason, "end_turn");
  assert.equal(r.model, "claude-haiku-5-5");
  assert.deepEqual(r.usage, {
    input_tokens: 100,
    output_tokens: 40,
    cache_read_input_tokens: 1000,
    cache_creation_input_tokens: 200,
  });
  assert.equal(streamOf.seen.responseFormat?.type, "json");
  assert.equal(streamOf.seen.maxOutputTokens, 1500);
  assert.ok(streamOf.seen.prompt.some((m) => m.role === "user" && m.content.some((c) => c.type === "file")));
});

test("an answer cut at the output limit says max_tokens, so llm.js asks again", async () => {
  const r = await send(request("gpt-5.4-mini"), { keys: {}, timeout: 5000, model: streamOf('{"text":"o', "length") });
  assert.equal(r.stop_reason, "max_tokens");
});

test("a provider error comes back with its HTTP status (a 429 is retried by llm.js, a 400 isn't)", async () => {
  const model = new MockLanguageModelV4({
    doStream: async () => {
      throw new APICallError({
        message: "Rate limited",
        url: "https://api.example",
        requestBodyValues: {},
        statusCode: 429,
        isRetryable: true,
      });
    },
  });
  await assert.rejects(
    () => send(request("gpt-5.4-mini"), { keys: {}, timeout: 5000, model }),
    (e) => e.status === 429,
  );
});

test("no key for the model's provider says which key to add", async () => {
  await assert.rejects(
    () => send(request("gpt-5.4-mini"), { keys: { anthropic: "k" }, timeout: 5000 }),
    /Add your OpenAI API key/,
  );
});

test("input is estimated locally: text at 3 characters a token, images by their size", () => {
  assert.equal(imageTokens(png), 1); // 4x2 pixels
  assert.equal(imageTokens(jpeg), Math.ceil((640 * 400) / 750));
  assert.equal(imageTokens(Buffer.from("not an image").toString("base64")), 1600);
  const n = countInput(request("claude-haiku-5-5"));
  const text =
    JSON.stringify(request("x").output_config.format.schema).length +
    "Rules.".length +
    "Long cached instructions.".length +
    '{"task":"Read"}'.length;
  assert.equal(n, Math.ceil(text / 3) + 1);
});

test("the most input a request can be billed for: a token per UTF-8 byte, each image's bound, the framing", () => {
  const bytes =
    JSON.stringify(request("x").output_config.format.schema).length +
    "Rules.".length +
    "Long cached instructions.".length +
    '{"task":"Read"}'.length;
  const framing = 1000 + 5 * 16; // the schema, two system blocks, an image and a text
  assert.equal(maxInputTokens(request("claude-haiku-5-5")), bytes + maxImageTokens(png) + framing);
  const dense = request("claude-haiku-5-5");
  dense.messages[0].content[1].text = "読む".repeat(300); // 600 characters, 1,800 bytes
  assert.equal(maxInputTokens(dense), bytes - '{"task":"Read"}'.length + 1800 + maxImageTokens(png) + framing);
  assert.ok(maxInputTokens(dense) > countInput(dense));
  // an image whose size can't be read has no bound
  const unknown = request("claude-haiku-5-5");
  unknown.messages[0].content[0].source.data = Buffer.from("not an image").toString("base64");
  assert.equal(maxInputTokens(unknown), null);
});

test("an image's bound covers the dearest documented billing of every provider, not one provider's 1,600", () => {
  const jpegOf = (w, h) =>
    Buffer.from(
      "ffd8ffe000104a46494600010100000100010000ffc0001108" +
        h.toString(16).padStart(4, "0") +
        w.toString(16).padStart(4, "0") +
        "03012200021101031101",
      "hex",
    ).toString("base64");
  assert.equal(maxImageTokens(jpeg), Math.ceil(20 * 13 * 2.46 + 2240)); // 640 x 400
  const shot = jpegOf(1280, 800); // a full-width screenshot
  // GPT-5.4 mini at high detail: up to 2,500 patches x 1.2 = 3,000; Anthropic: 1280 x 800 / 750 = 1,366
  assert.ok(maxImageTokens(shot) >= 3000);
  assert.ok(maxImageTokens(shot) >= Math.ceil((1280 * 800) / 750));
  assert.ok(maxImageTokens(shot) >= 85 + 8 * 170); // OpenAI's 512 px tiles, a small image scaled up
  assert.ok(maxImageTokens(jpegOf(16, 16)) >= 2240); // Gemini 3's ultra-high resolution, whatever the size
  assert.equal(maxImageTokens(Buffer.from("not an image").toString("base64")), null);
});

// planning, checks, take-overs, form filling and list reading send screenshots: a model that can't read them isn't offered
test("only models that read screenshots are offered, and a text-only model is refused by name", async () => {
  const { CATALOG, MODELS } = await import("../src/models.ts");
  const { LLM } = await import("../src/llm.ts");
  assert.ok(MODELS.length > 0);
  for (const id of MODELS) assert.equal(CATALOG[id].vision, true, id);
  CATALOG["text-only-fixture"] = { provider: "fireworks", label: "Text Only", prices: [1, 1, 1, 1], vision: false };
  try {
    const { MODELS: again } = await import("../src/models.ts");
    assert.equal(again.includes("text-only-fixture"), false);
    assert.throws(() => new LLM({ key: "k", model: "text-only-fixture" }), /Text Only can't read screenshots/);
  } finally {
    delete CATALOG["text-only-fixture"];
  }
});

// one LLM key field: the provider is told from the key itself
test("a pasted key is told by its prefix, and each provider starts on a model that's offered and reads screenshots", async () => {
  const { providerOfKey, PROVIDERS, MODELS, CATALOG, providerOf } = await import("../src/models.ts");
  const cases = {
    "sk-ant-api03-x": "anthropic",
    "sk-or-v1-x": "openrouter",
    fw_3ZLx: "fireworks",
    AIzaSyAZx: "google",
    "sk-proj-x": "openai",
    "sk-svcacct-x": "openai",
    " sk-ant-x ": "anthropic",
    nace_sk_x: null,
    hello: null,
    "": null,
  };
  for (const [key, want] of Object.entries(cases)) assert.equal(providerOfKey(key), want, key);
  for (const [id, p] of Object.entries(PROVIDERS)) {
    assert.ok(MODELS.includes(p.defaultModel), `${id} default ${p.defaultModel} is offered`);
    assert.equal(providerOf(p.defaultModel), id);
    assert.equal(CATALOG[p.defaultModel].vision, true);
  }
});

// Qwen's chat template on Fireworks refused two system messages ("System message must be at the beginning": 45 of 66
// eval attempts); the split exists only for Anthropic's cache marks
test("providers other than Anthropic get one system message, Anthropic keeps its cache-marked blocks", () => {
  for (const [model, provider] of [
    ["accounts/fireworks/models/qwen3p8-max", "fireworks"],
    ["gpt-6-luna", "openai"],
    ["gemini-3.1-flash-lite", "google"],
    ["z-ai/glm-5.3-flash", "openrouter"],
  ]) {
    const o = callOptions(request(model), provider);
    assert.deepEqual(o.instructions, [{ role: "system", content: "Rules.\n\nLong cached instructions." }], provider);
  }
  assert.equal(callOptions(request("claude-haiku-5-5"), "anthropic").instructions.length, 2);
});

// the run's $0.08 cap was sized for Haiku: on a pricier model (Sonnet, Opus, GPT-5.4 mini, Qwen 3.8 Max) runs ended
// "partial" after a call or two. The default cap now scales with the model's price; a cap set in runLimits still wins
test("the default run cost cap scales with the model's price, and a set cap still wins", async () => {
  const { runCostCap } = await import("../src/models.ts");
  assert.equal(runCostCap("claude-haiku-5-5"), 0.08);
  assert.equal(runCostCap("gpt-6-luna"), 0.08);
  assert.ok(Math.abs(runCostCap("claude-sonnet-5-5") - 1.6) < 1e-9);
  assert.ok(Math.abs(runCostCap("claude-opus-5-5") - 3.2) < 1e-9);
  assert.ok(runCostCap("z-ai/glm-5.3-flash") === 0.08); // cheaper models keep the Haiku cap, not less
});
