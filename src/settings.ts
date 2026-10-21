// The settings in chrome.storage.local, read by the service worker (for each run) and by the panel (to show them).
import { DEFAULT_MODEL, MODELS, PROVIDERS, providerOf } from "./models.ts";
import type { KeyName, ModelId, ProviderId, Settings } from "./types.ts";

/** What older builds left in storage: any key may be missing, and the model may be one no longer offered. */
type Stored = Partial<Omit<Settings, "model">> & { model?: string };

const KEYS: (keyof Settings)[] = [
  "drexKey",
  "anthropicKey",
  "openaiKey",
  "fireworksKey",
  "googleKey",
  "openrouterKey",
  "model",
  "background",
  "approvals",
  "unattended",
  "notify",
  "cursor",
  "planning",
  "bridge",
  "bridgeCode",
  "runLimits",
];

export async function loadSettings(): Promise<Settings> {
  const stored: Stored = await chrome.storage.local.get(KEYS);
  const keyNames: (KeyName | "drexKey")[] = ["drexKey", ...Object.values(PROVIDERS).map((p) => p.keyName)];
  if (keyNames.some((k) => !stored[k])) {
    try {
      // keys.local.json is written by build.mjs from .env; it only fills keys that are not set yet
      const local = (await (await fetch(chrome.runtime.getURL("keys.local.json"))).json()) as Partial<
        Record<KeyName | "drexKey", string>
      >;
      const fill: Partial<Record<KeyName | "drexKey", string>> = {};
      for (const k of keyNames) if (!stored[k] && local[k]) fill[k] = local[k];
      await chrome.storage.local.set(fill);
      Object.assign(stored, fill);
    } catch {}
  }
  return {
    background: true,
    approvals: true,
    unattended: false,
    notify: true,
    cursor: true,
    planning: true,
    bridge: false,
    ...stored,
    // a model no longer offered (no prices yet, or it can't read screenshots) falls back to the default
    model: (MODELS as (string | undefined)[]).includes(stored.model) ? (stored.model as ModelId) : DEFAULT_MODEL,
  };
}

/** Each LLM provider's key, as LLM takes them. */
export const llmKeys = (s: Partial<Settings>): Record<ProviderId, string> =>
  Object.fromEntries(Object.entries(PROVIDERS).map(([id, p]) => [id, s[p.keyName] || ""])) as Record<
    ProviderId,
    string
  >;

/** The key a run still needs, by name ("Drex", "OpenAI"...): Drex's, and the chosen model's provider's. */
export function missingKey(s: Settings): string | null {
  if (!s.drexKey) return "Drex";
  const p = PROVIDERS[providerOf(s.model)];
  return s[p.keyName] ? null : p.label;
}
