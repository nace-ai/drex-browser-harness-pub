// Every LLM call goes through the AI SDK (ai + @ai-sdk/*). llm.ts builds one request in the shape it has always used
// (system, messages of text and image blocks, a JSON schema, an effort); send() makes it a streamed AI SDK call for the
// model's provider and turns the answer back into that shape (text, usage, stop reason). A new provider is a factory
// line here and its models in models.ts.
import { Output, jsonSchema, streamText } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createFireworks } from "@ai-sdk/fireworks";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { PROVIDERS, providerOf } from "./models.ts";
import type { FilePart, FinishReason, ModelMessage, TextPart, LanguageModel, LanguageModelUsage } from "ai";
import type { ApiKeys, LlmAnswer, LlmBlock, LlmRequest, ProviderId, SystemBlock } from "./types.ts";

const FACTORIES: Record<ProviderId, (apiKey: string) => (model: string) => LanguageModel> = {
  // the extension's worker is a browser: Anthropic wants it said that a browser calls the API directly
  anthropic: (apiKey) => createAnthropic({ apiKey, headers: { "anthropic-dangerous-direct-browser-access": "true" } }),
  openai: (apiKey) => createOpenAI({ apiKey }),
  fireworks: (apiKey) => createFireworks({ apiKey }),
  google: (apiKey) => createGoogleGenerativeAI({ apiKey }),
  openrouter: (apiKey) => createOpenRouter({ apiKey }),
};

export function languageModel(model: string, keys: ApiKeys): LanguageModel {
  const provider = providerOf(model);
  if (!keys[provider])
    throw new Error(`Add your ${PROVIDERS[provider].label} API key in the settings to use ${model}.`);
  return FACTORIES[provider](keys[provider])(model);
}

const part = (block: LlmBlock, provider: ProviderId): FilePart | TextPart =>
  block.type === "image"
    ? { type: "file", data: block.source.data, mediaType: block.source.media_type }
    : {
        type: "text",
        text: block.text,
        ...(block.cache_control && provider === "anthropic"
          ? { providerOptions: { anthropic: { cacheControl: block.cache_control } } }
          : {}),
      };

/** The AI SDK options for one request. Anthropic gets its native JSON output and its own effort setting (the portable
 * `reasoning` would turn on thinking there); the others get `reasoning`, which they map to their effort setting. */
type StreamOptions = Parameters<typeof streamText>[0];
/** What callOptions hands to streamText besides the model and the abort signal. */
type CallOptions = Pick<
  StreamOptions,
  "instructions" | "maxOutputTokens" | "maxRetries" | "reasoning" | "output" | "providerOptions"
> & { messages: ModelMessage[] };

export function callOptions(request: LlmRequest, provider: ProviderId): CallOptions {
  const system: SystemBlock[] = Array.isArray(request.system)
    ? request.system
    : [{ type: "text", text: request.system }];
  const cache = (b: { cache_control?: { type: "ephemeral"; ttl?: string } }) =>
    b.cache_control && provider === "anthropic"
      ? {
          providerOptions: {
            anthropic: {
              cacheControl: { type: "ephemeral", ...(b.cache_control.ttl ? { ttl: b.cache_control.ttl } : {}) },
            },
          },
        }
      : {};
  const schema = request.output_config?.format?.schema;
  const effort = request.output_config?.effort;
  return {
    // system text goes in `instructions` (v7 refuses system messages among the messages). Anthropic gets each block with
    // its cache mark; the others one message, since chat templates like Qwen's on Fireworks refuse a second
    instructions:
      provider === "anthropic"
        ? system.map((b) => ({ role: "system", content: b.text, ...cache(b) }))
        : [{ role: "system", content: system.map((b) => b.text).join("\n\n") }],
    messages: request.messages.map((m) => ({ role: m.role, content: m.content.map((b) => part(b, provider)) })),
    maxOutputTokens: request.max_tokens,
    maxRetries: 0, // llm.ts retries, so that every attempt passes the run budget
    ...(schema ? { output: Output.object({ schema: jsonSchema(schema) }) } : {}),
    ...(provider === "anthropic"
      ? {
          providerOptions: {
            anthropic: {
              structuredOutputMode: "outputFormat",
              ...(effort ? { effort } : {}),
              // the noThink cost switch: no hidden reasoning tokens, which bill as output
              ...(request.noThinking ? { thinking: { type: "disabled" } } : {}),
            },
          },
        }
      : effort
        ? { reasoning: effort }
        : {}),
  };
}

const STOP: Partial<Record<FinishReason, string>> = { length: "max_tokens", "content-filter": "refusal" };

/** The answer in llm.ts's shape. Input tokens are split into uncached, cache reads and cache writes. */
export function answer({
  text,
  usage = {},
  finishReason,
  model,
}: {
  text: string;
  usage?: Partial<LanguageModelUsage>;
  finishReason: FinishReason;
  model: string;
}): LlmAnswer {
  const read = usage.inputTokenDetails?.cacheReadTokens ?? 0,
    write = usage.inputTokenDetails?.cacheWriteTokens ?? 0;
  const plain = usage.inputTokenDetails?.noCacheTokens ?? Math.max(0, (usage.inputTokens ?? 0) - read - write);
  return {
    content: [{ type: "text", text }],
    model,
    stop_reason: STOP[finishReason] ?? "end_turn",
    usage: {
      input_tokens: plain,
      output_tokens: usage.outputTokens ?? 0,
      cache_read_input_tokens: read,
      cache_creation_input_tokens: write,
    },
  };
}

/** An AI SDK error with the HTTP status llm.ts looks at (rate limits and server errors are retried, others aren't). */
type SdkError = Error & { statusCode?: number; status?: number | null; isRetryable?: boolean; unreadable?: boolean };
export function failure(error: unknown): SdkError {
  if (!error || typeof error !== "object") return new Error(String(error));
  const e = error as SdkError;
  // a 200 answer the SDK couldn't read (no body, or a body that isn't the event stream): answered, maybe billed, unusable
  if (
    /Failed to process successful response/i.test(e.message || "") ||
    e.name === "AI_EmptyResponseBodyError" ||
    e.name === "AI_NoOutputGeneratedError"
  )
    e.unreadable = true;
  if (Number.isInteger(e.statusCode) && e.status == null) e.status = e.statusCode;
  // a dropped connection: no status, but retryable (llm.ts retries connection errors, not timeouts)
  if (e.status == null && e.isRetryable && !/timeout|abort/i.test(e.name || "")) e.name = "APIConnectionError";
  return e;
}

/** One streamed call (the answer starts at once, so the extension's worker isn't stopped for a fetch waiting 30 s). */
export async function send(
  request: LlmRequest,
  { keys, timeout, model: lm = null }: { keys: ApiKeys; timeout: number; model?: LanguageModel | null },
): Promise<LlmAnswer> {
  const provider = providerOf(request.model);
  let streamError: unknown;
  const stream = streamText({
    model: lm || languageModel(request.model, keys),
    ...callOptions(request, provider),
    abortSignal: AbortSignal.timeout(Math.max(1, timeout)),
    onError: ({ error }) => {
      streamError = error;
    },
  });
  let text: string, usage: Awaited<typeof stream.usage>, finishReason: Awaited<typeof stream.finishReason>;
  try {
    [text, usage, finishReason] = await Promise.all([stream.text, stream.usage, stream.finishReason]);
  } catch (error) {
    // a failed stream rejects with "No output generated"; the provider's own error came through onError
    throw failure(streamError || error);
  }
  // an error event in the middle of a 200 stream (overloaded mid-answer) doesn't reject: the stream ends with what came
  // before it and no usage. It was answered and maybe billed, but nothing usable came.
  if (finishReason === "error")
    throw Object.assign(failure(streamError ?? new Error("The answer's stream ended with an error")), {
      unreadable: true,
    });
  // a 200 stream that closed before its last events (cut by a proxy or the worker) resolves with the partial text and
  // no token counts: counted as 0 it would be a complete $0 answer, so it is unreadable too
  if (usage.inputTokens == null || usage.outputTokens == null)
    throw Object.assign(new Error("The answer's stream ended without its token counts"), { unreadable: true });
  return answer({ text, usage, finishReason, model: request.model });
}

/** The request's input tokens, estimated here instead of asking a provider (only Anthropic can count, and that costs
 * a round trip per call): text at 3 characters a token, which overcounts English a little, and each image by its size
 * (about width x height / 750 tokens, at most 1,600). */
export function countInput(request: Pick<LlmRequest, "model" | "system" | "messages" | "output_config">): number {
  let chars = 0,
    images = 0;
  for (const part of inputParts(request))
    if (typeof part === "string") chars += part.length;
    else images += imageTokens(part.image);
  return Math.ceil(chars / 3) + images;
}

/** The most input tokens the request can be billed for, where countInput() is only an estimate (dense or non-English
 * text can take more than one token per 3 characters): a byte-level tokenizer makes at most one token of each UTF-8
 * byte, and each image at most maxImageTokens(). A fixed allowance covers the framing a provider adds (roles, message
 * separators, its structured-output instructions). Null when an image's size can't be read: then there is no bound. */
export function maxInputTokens(
  request: Pick<LlmRequest, "model" | "system" | "messages" | "output_config">,
): number | null {
  const utf8 = new TextEncoder();
  let tokens = FRAMING_TOKENS;
  for (const part of inputParts(request)) {
    const n = typeof part === "string" ? utf8.encode(part).length : maxImageTokens(part.image);
    if (n === null) return null;
    tokens += n + PART_FRAMING_TOKENS;
  }
  return tokens;
}

const FRAMING_TOKENS = 1000,
  PART_FRAMING_TOKENS = 16;
/** The most one image can be billed for by any provider the catalog uses, from its pixels: the dearest documented
 * per-pixel rate (OpenAI's 32 px patches at their largest multiplier, 2.46, about a token per 416 pixels, above
 * Anthropic's 750 and Gemini's 768 x 768 tiles at 258), with each side rounded up to a whole patch, plus the dearest
 * fixed charge a small image can get (OpenAI's tiles scale it up to 768 px: 85 + 8 x 170; Gemini 3's ultra-high
 * resolution, 2,240). Null for an image whose size isn't in its header. */
export function maxImageTokens(base64: string): number | null {
  const size = pixels(atob(base64.slice(0, 40000)));
  if (!size) return null;
  return Math.ceil(Math.ceil(size.w / 32) * Math.ceil(size.h / 32) * 2.46 + 2240);
}

function inputParts(
  request: Pick<LlmRequest, "model" | "system" | "messages" | "output_config">,
): (string | { image: string })[] {
  const parts: (string | { image: string })[] = [JSON.stringify(request.output_config?.format?.schema ?? "")];
  const system = Array.isArray(request.system) ? request.system : [{ text: request.system }];
  for (const b of system) parts.push(b.text || "");
  for (const m of request.messages)
    for (const b of m.content) parts.push(b.type === "image" ? { image: b.source.data } : b.text || "");
  return parts;
}

const MAX_IMAGE_TOKENS = 1600;
/** An image's tokens from its PNG or JPEG header (the rest of the data isn't read). */
export function imageTokens(base64: string): number {
  const size = pixels(atob(base64.slice(0, 40000)));
  return size ? Math.min(MAX_IMAGE_TOKENS, Math.ceil((size.w * size.h) / 750)) : MAX_IMAGE_TOKENS;
}
function pixels(bin: string): { w: number; h: number } | null {
  const u16 = (i: number) => (bin.charCodeAt(i) << 8) | bin.charCodeAt(i + 1);
  if (bin.startsWith("\x89PNG")) return { w: (u16(16) << 16) | u16(18), h: (u16(20) << 16) | u16(22) };
  if (bin.charCodeAt(0) !== 0xff || bin.charCodeAt(1) !== 0xd8) return null;
  for (let i = 2; i + 9 < bin.length;) {
    // JPEG: walk the segments to a start-of-frame
    if (bin.charCodeAt(i) !== 0xff) return null;
    const marker = bin.charCodeAt(i + 1);
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker))
      return { h: u16(i + 5), w: u16(i + 7) };
    i += 2 + u16(i + 2);
  }
  return null;
}
