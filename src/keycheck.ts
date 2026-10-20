// "Check keys" in the settings: one small call per key, so a key problem shows in seconds instead of in the middle of
// a task. The Drex check is one tiny decision (a fraction of a millionth of a dollar); the Anthropic check counts the
// tokens of one word, which is free; the OpenAI and Fireworks checks ask for a two-word answer (a key can list models
// while its account has no credits left, and only a real call shows that).
import { DREX_MODEL, DREX_URL, bodyOf, wrongModelMessage } from "./drex.ts";
import type { KeyCheck, LlmKeyCheck, ProviderId } from "./types.ts";

type FetchFn = typeof fetch;
/** The error body of a failed call. A provider may send anything in these fields. */
type ErrorBody = { error?: { code?: unknown; type?: unknown; message?: string | false | 0 | null } | null } | null;
const errorOf = (r: Response): Promise<ErrorBody> => r.json().catch(() => ({})) as Promise<ErrorBody>;
const reason = async (r: Response): Promise<string> => (await errorOf(r))?.error?.message || "";

export async function checkDrexKey(key: string | undefined, fetchFn: FetchFn = fetch): Promise<KeyCheck> {
  if (!key) return { ok: false, message: "No key." };
  try {
    const r = await fetchFn(DREX_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: DREX_MODEL,
        state: "A key check.",
        questions: { check: { type: "noul", instructions: "Is this a key check?" } },
      }),
    });
    if (r.status === 401 || r.status === 403)
      return { ok: false, message: `Drex rejected this key (HTTP ${r.status}).` };
    if (!r.ok) return { ok: false, message: `Drex answered HTTP ${r.status}. ${await reason(r)}`.trim() };
    const j = bodyOf(await r.json());
    if (j.model && j.model !== DREX_MODEL) return { ok: false, message: wrongModelMessage(DREX_MODEL, j.model) };
    return { ok: true, message: "Works with Drex Max." };
  } catch (e) {
    return { ok: false, message: `Couldn't reach Drex: ${(e as Error).message}` };
  }
}

export async function checkAnthropicKey(
  key: string | undefined,
  model: string,
  fetchFn: FetchFn = fetch,
): Promise<KeyCheck> {
  if (!key) return { ok: false, message: "No key." };
  try {
    const r = await fetchFn("https://api.anthropic.com/v1/messages/count_tokens", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({ model, messages: [{ role: "user", content: "Key check." }] }),
    });
    if (r.status === 401 || r.status === 403)
      return { ok: false, message: `Anthropic rejected this key (HTTP ${r.status}).` };
    if (!r.ok) return { ok: false, message: `Anthropic answered HTTP ${r.status}. ${await reason(r)}`.trim() };
    return { ok: true, message: "Works." };
  } catch (e) {
    return { ok: false, message: `Couldn't reach Anthropic: ${(e as Error).message}` };
  }
}

/** One tiny call; 401/403 is a rejected key, a quota error is an empty balance. */
async function tinyCall(
  label: string,
  url: string,
  key: string | undefined,
  body: object,
  fetchFn: FetchFn,
  headers: Record<string, string> = { Authorization: `Bearer ${key}` },
): Promise<KeyCheck> {
  if (!key) return { ok: false, message: "No key." };
  try {
    const r = await fetchFn(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
    if (r.ok) return { ok: true, message: "Works." };
    const error = (await errorOf(r))?.error ?? {};
    if (r.status === 401 || r.status === 403)
      return { ok: false, message: `${label} rejected this key (HTTP ${r.status}).` };
    if (/credit|quota|balance|billing/i.test(`${String(error.code)} ${String(error.type)} ${String(error.message)}`))
      return {
        ok: false,
        message: `This ${label} account has no credits left: ${error.message || `HTTP ${r.status}`}`,
      };
    return { ok: false, message: `${label} answered HTTP ${r.status}. ${error.message || ""}`.trim() };
  } catch (e) {
    return { ok: false, message: `Couldn't reach ${label}: ${(e as Error).message}` };
  }
}

export const checkOpenAIKey = (key: string | undefined, model: string, fetchFn: FetchFn = fetch): Promise<KeyCheck> =>
  tinyCall(
    "OpenAI",
    "https://api.openai.com/v1/responses",
    key,
    { model, input: "Say ok.", max_output_tokens: 16 },
    fetchFn,
  );

export const checkFireworksKey = (
  key: string | undefined,
  model: string,
  fetchFn: FetchFn = fetch,
): Promise<KeyCheck> =>
  tinyCall(
    "Fireworks",
    "https://api.fireworks.ai/inference/v1/chat/completions",
    key,
    { model, messages: [{ role: "user", content: "Say ok." }], max_tokens: 4 },
    fetchFn,
  );

export const checkOpenRouterKey = (
  key: string | undefined,
  model: string,
  fetchFn: FetchFn = fetch,
): Promise<KeyCheck> =>
  tinyCall(
    "OpenRouter",
    "https://openrouter.ai/api/v1/chat/completions",
    key,
    { model, messages: [{ role: "user", content: "Say ok." }], max_tokens: 4 },
    fetchFn,
  );

export const checkGoogleKey = (key: string | undefined, model: string, fetchFn: FetchFn = fetch): Promise<KeyCheck> =>
  tinyCall(
    "Google Gemini",
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    key,
    { contents: [{ parts: [{ text: "Say ok." }] }], generationConfig: { maxOutputTokens: 4 } },
    fetchFn,
    { "x-goog-api-key": key ?? "" },
  );

/** The check for each provider's key, given the model to try it with. */
export const LLM_KEY_CHECKS: Record<ProviderId, LlmKeyCheck> = {
  anthropic: checkAnthropicKey,
  openai: checkOpenAIKey,
  fireworks: checkFireworksKey,
  google: checkGoogleKey,
  openrouter: checkOpenRouterKey,
};
