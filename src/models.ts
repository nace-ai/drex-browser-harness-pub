// The LLMs the agent can use: which provider serves each one, its prices, and whether it reads screenshots (planning,
// checks and take-overs send them). Kept apart from llm.ts so the panel can list them without bundling the AI SDK.
// A model is offered only with prices: the cost meter and the run budget count every call in dollars.
import type { CatalogEntry, ModelId, Prices, ProviderEntry, ProviderId } from "./types.ts";

/** Providers: the settings key that holds each one's API key, how to tell its keys apart, and the model a new key of
 * theirs starts with. A key is told by its prefix; the order matters (Anthropic and OpenRouter keys also start "sk-"). */
export const PROVIDERS = {
  anthropic: { label: "Anthropic", keyName: "anthropicKey", prefix: /^sk-ant-/, defaultModel: "claude-haiku-5-5" },
  openrouter: {
    label: "OpenRouter",
    keyName: "openrouterKey",
    prefix: /^sk-or-/,
    defaultModel: "anthropic/claude-haiku-5.5",
  },
  fireworks: {
    label: "Fireworks",
    keyName: "fireworksKey",
    prefix: /^fw_/,
    defaultModel: "accounts/fireworks/models/glm-5p3-flash",
  },
  google: { label: "Google Gemini", keyName: "googleKey", prefix: /^AIza/, defaultModel: "gemini-3.8-flash" },
  openai: { label: "OpenAI", keyName: "openaiKey", prefix: /^sk-/, defaultModel: "gpt-6-luna" },
} as const satisfies Record<string, ProviderEntry>;

/** The provider a pasted key belongs to, or null (a Drex key, or nothing we know). */
export const providerOfKey = (key: unknown): ProviderId | null =>
  // eslint-disable-next-line @typescript-eslint/no-base-to-string -- the panel passes a string; any other value is stringified as before
  (Object.entries(PROVIDERS).find(([, p]) => p.prefix.test(String(key || "").trim()))?.[0] as ProviderId | undefined) ||
  null;

// $ per million tokens: input, output, cache read, cache write. Sonnet 5.5 cache reads are $0.10. Models without
// checked prices (null) are listed here but not offered. vision: reads screenshots, checked with a real screenshot
// call; only those are offered (planning, checks, take-overs, form filling and list reading send screenshots).
export const CATALOG = {
  "claude-haiku-5-5": {
    provider: "anthropic",
    label: "Claude Haiku 5.5",
    prices: [0.1, 0.5, 0.01, 0.125],
    vision: true,
  },
  "claude-sonnet-5-5": { provider: "anthropic", label: "Claude Sonnet 5.5", prices: [2, 10, 0.1, 2.5], vision: true },
  "claude-opus-5-5": { provider: "anthropic", label: "Claude Opus 5.5", prices: [4, 20, 0.2, 5], vision: true },
  // OpenAI and Fireworks: https://developers.openai.com/api/docs/pricing, https://docs.fireworks.ai/serverless/pricing
  // (2026-10-19, standard tier). Neither charges extra for cache writes, so a write costs plain input.
  "gpt-6-luna": { provider: "openai", label: "GPT-6 Luna", prices: [0.1, 0.5, 0.01, 0.1], vision: true },
  // offered: false: in the 2026-10-19 eval (66 attempts each; Haiku 47, $0.0030), GPT-5.4 mini passed 38 at 4-10x the
  // cost, DeepSeek V4.1 Flash on Fireworks 43 at 2.5x and 51 s an attempt, Qwen 3.8 Max (a thinking model) ran out of
  // output tokens at 20x. They stay listed so the eval can run them.
  "gpt-5.4-mini": {
    provider: "openai",
    label: "GPT-5.4 mini",
    prices: [0.75, 4.5, 0.075, 0.75],
    vision: true,
    offered: false,
  },
  "accounts/fireworks/models/glm-5p3-flash": {
    provider: "fireworks",
    label: "GLM-5.3 Flash (Fireworks)",
    prices: [0.15, 0.5, 0.03, 0.15],
    vision: true,
  },
  "accounts/fireworks/models/deepseek-v4p1-flash": {
    provider: "fireworks",
    label: "DeepSeek V4.1 Flash (Fireworks)",
    prices: [0.3, 1.2, 0.006, 0.3],
    vision: true,
    offered: false,
  },
  "accounts/fireworks/models/qwen3p8-max": {
    provider: "fireworks",
    label: "Qwen 3.8 Max (Fireworks)",
    prices: [2, 6, 0.25, 2],
    vision: true,
    offered: false,
  },
  // Google: https://ai.google.dev/gemini-api/docs/pricing (paid tier; Gemini 3.8 Flash doubles from 2027-01-01)
  // second eval (66 attempts each; Haiku 46, $0.0029): Gemini 3.8 Flash 48 at $0.0075 and 16 s; Gemini 3.1 Flash-Lite
  // 39 at $0.0049 (not offered); through OpenRouter Haiku 49, GPT-6 Luna 47, GLM-5.3 Flash 40 with 11 answers cut off
  // and DeepSeek V4.1 Flash 31 (not offered)
  "gemini-3.1-flash-lite": {
    provider: "google",
    label: "Gemini 3.1 Flash-Lite",
    prices: [0.25, 1.5, 0.025, 0.25],
    vision: true,
    offered: false,
  },
  "gemini-3.8-flash": {
    provider: "google",
    label: "Gemini 3.8 Flash",
    prices: [0.75, 3.75, 0.075, 0.75],
    vision: true,
  },
  // OpenRouter: one key for models of many providers, priced from its models API (https://openrouter.ai/api/v1/models)
  "anthropic/claude-haiku-5.5": {
    provider: "openrouter",
    label: "Claude Haiku 5.5 (OpenRouter)",
    prices: [0.1, 0.5, 0.01, 0.125],
    vision: true,
  },
  "openai/gpt-6-luna": {
    provider: "openrouter",
    label: "GPT-6 Luna (OpenRouter)",
    prices: [0.1, 0.5, 0.01, 0.125],
    vision: true,
  },
  "google/gemini-3.1-flash-lite": {
    provider: "openrouter",
    label: "Gemini 3.1 Flash-Lite (OpenRouter)",
    prices: [0.25, 1.5, 0.025, 0.0833],
    vision: true,
    offered: false,
  },
  "z-ai/glm-5.3-flash": {
    provider: "openrouter",
    label: "GLM-5.3 Flash (OpenRouter)",
    prices: [0.048, 0.16, 0.006, 0.048],
    vision: true,
    offered: false,
  },
  "deepseek/deepseek-v4.1-flash": {
    provider: "openrouter",
    label: "DeepSeek V4.1 Flash (OpenRouter)",
    // OpenRouter's models API, 2026-10-20
    prices: [0.0352, 0.0112, 0.0016, 0.0352],
    vision: true,
    offered: false,
  },
} as const satisfies Record<string, CatalogEntry>;
type Catalog = Readonly<Record<string, CatalogEntry>>;
type Entries = Readonly<Record<ModelId, CatalogEntry>>;

export const PRICES = Object.fromEntries(
  Object.entries(CATALOG as Catalog)
    .filter(([, m]) => m.prices)
    .map(([id, m]) => [id, m.prices]),
) as Record<string, Prices>;
export const MODELS = Object.keys(PRICES).filter(
  (id) => (CATALOG as Entries)[id as ModelId].vision === true && (CATALOG as Entries)[id as ModelId].offered !== false,
);
export const DEFAULT_MODEL = "claude-haiku-5-5";
export const MODEL_NAMES = Object.fromEntries(Object.entries(CATALOG).map(([id, m]) => [id, m.label]));
export const providerOf = (model: string): ProviderId => (CATALOG as Catalog)[model]?.provider || "anthropic";

/** A run's default cost cap: the run budget's $0.08 loop guard at Haiku's prices, scaled up for a pricier model by its
 * input + output price (Sonnet $1.60, Opus $3.20), never below $0.08. A cap set in runLimits overrides it. */
export function runCostCap(model: string): number {
  const prices = (CATALOG as Catalog)[model]?.prices,
    haiku = CATALOG["claude-haiku-5-5"].prices;
  return 0.08 * Math.max(1, prices ? (prices[0] + prices[1]) / (haiku[0] + haiku[1]) : 1);
}
