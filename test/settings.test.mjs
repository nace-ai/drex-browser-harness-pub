import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_MODEL, MODELS } from "../src/models.ts";
import { loadSettings } from "../src/settings.ts";

// chrome.storage.local and keys.local.json, faked: `stored` is what older builds left in storage, `file` the build's keys file (null: none)
async function withStorage(stored, file, fn) {
  const { chrome: oldChrome, fetch: oldFetch } = globalThis;
  const sets = [];
  globalThis.chrome = {
    storage: {
      local: {
        get: async () => ({ ...stored }),
        set: async (v) => {
          sets.push(v);
        },
      },
    },
    runtime: { getURL: (p) => p },
  };
  globalThis.fetch = file
    ? async () => ({ json: async () => file })
    : async () => {
        throw new Error("no keys file");
      };
  try {
    await fn(sets);
  } finally {
    globalThis.chrome = oldChrome;
    globalThis.fetch = oldFetch;
  }
}

test("defaults when storage is empty and there is no keys file", () =>
  withStorage({}, null, async () => {
    assert.deepEqual(await loadSettings(), {
      background: true,
      approvals: true,
      unattended: false,
      notify: true,
      cursor: true,
      planning: true,
      bridge: false,
      model: DEFAULT_MODEL,
    });
  }));

test("a stored model that is no longer offered falls back", () =>
  withStorage({ model: "gone-model" }, null, async () => {
    assert.equal((await loadSettings()).model, DEFAULT_MODEL);
  }));

test("an offered stored model is kept", () =>
  withStorage({ model: MODELS.at(-1) }, null, async () => {
    assert.equal((await loadSettings()).model, MODELS.at(-1));
  }));

test("keys.local.json fills only missing keys", () =>
  withStorage({ drexKey: "d1" }, { drexKey: "x", anthropicKey: "a1" }, async (sets) => {
    const s = await loadSettings();
    assert.equal(s.drexKey, "d1");
    assert.equal(s.anthropicKey, "a1");
    assert.deepEqual(sets, [{ anthropicKey: "a1" }]);
  }));
