// What the runner sends the extension with a run (runner/src/run.mjs overOf), the extension builds it refuses to load,
// and the release build's guard (scripts/check-release.mjs). No browser.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { DEFAULT_MODEL, extensionDir, keysFrom, overOf } from "../runner/src/run.mjs";
import { missingKey } from "../src/settings.ts";
import { PROVIDERS } from "../src/models.ts";
import { releaseProblems } from "../scripts/check-release.mjs";

const keys = { drexKey: "d", anthropicKey: "a" };
const limits = { maxSeconds: 600, maxLlmCalls: 20 };

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nb-run-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("a run denies risky clicks unless --allow-risky, and sends its keys and limits with the run", () => {
  assert.deepEqual(overOf({ limits }, keys), {
    drexKey: "d",
    anthropicKey: "a",
    // unset keys sent empty: a key saved in the profile by a headed run's panel is not used
    openaiKey: "",
    fireworksKey: "",
    googleKey: "",
    openrouterKey: "",
    runLimits: { maxSeconds: 600, maxHaikuCalls: 20 }, // no cost limit: the extension scales its own to the model
    approvals: true,
    report: { expect: "" },
    notify: false,
    model: "claude-haiku-5-5", // always named: a model saved in the profile by a headed run's panel is not used
  });
  const allowed = overOf({ limits: { ...limits, maxCostUsd: 0.5 }, allowRisky: true, model: "gpt-5.5" }, keys);
  assert.equal(allowed.approvals, false);
  assert.deepEqual(allowed.runLimits, { maxCostUsd: 0.5, maxSeconds: 600, maxHaikuCalls: 20 });
  assert.equal(allowed.model, "gpt-5.5");
  // a caller's deadline (the cloud worker's) shortens the extension's budget by the time the browser took to start
  assert.equal(overOf({ limits, endsAt: Date.now() + 90500 }, keys).runLimits.maxSeconds, 90);
  assert.equal(overOf({ limits, endsAt: Date.now() - 1000 }, keys).runLimits.maxSeconds, 1);
});

test("the runner's default model is the extension's", () => {
  const models = fs.readFileSync(new URL("../src/models.ts", import.meta.url), "utf8");
  assert.equal(models.match(/export const DEFAULT_MODEL = "([^"]+)"/)?.[1], DEFAULT_MODEL);
});

test("the runner won't load an extension build that holds keys (the extension would save them in the profile)", (t) => {
  const dir = tmp(t);
  fs.writeFileSync(path.join(dir, "manifest.json"), "{}");
  assert.equal(extensionDir({ NACE_BROWSER_EXTENSION: dir }), dir);
  fs.writeFileSync(path.join(dir, "keys.local.json"), "{}");
  assert.throws(
    () => extensionDir({ NACE_BROWSER_EXTENSION: dir }),
    (e) => e.code === "extension_has_keys",
  );
  assert.throws(
    () => extensionDir({ NACE_BROWSER_EXTENSION: path.join(dir, "none") }),
    (e) => e.code === "extension_missing",
  );
});

// extensionDir finds the packaged builds next to runner/src; a checkout may have neither (no release build yet), so the
// path each mode asks for is read off the error when it is missing
test("the runner loads the packaged extension of the mode: extension/ for default, extension-loop/ for loop", () => {
  const rootDir = fileURLToPath(new URL("../runner/", import.meta.url));
  const picked = (env, mode) => {
    try {
      return extensionDir(env, mode);
    } catch (e) {
      assert.equal(e.code, "extension_missing");
      return e.message.match(/No extension build at (\S+)\./)?.[1];
    }
  };
  assert.equal(picked({}, undefined), path.join(rootDir, "extension-loop"));
  assert.equal(picked({}, "default"), path.join(rootDir, "extension"));
  assert.equal(picked({}, "loop"), path.join(rootDir, "extension-loop"));
  // the environment picks the mode when the caller doesn't, and an unknown one is refused, not run as the default
  assert.equal(picked({ NACE_BROWSER_MODE: "loop" }, undefined), path.join(rootDir, "extension-loop"));
  assert.throws(() => extensionDir({}, "fast"), /one of default, loop/);
});

test("NACE_BROWSER_EXTENSION wins over the mode", (t) => {
  const dir = tmp(t);
  fs.writeFileSync(path.join(dir, "manifest.json"), "{}");
  assert.equal(extensionDir({ NACE_BROWSER_EXTENSION: dir }, "loop"), dir);
  assert.equal(extensionDir({ NACE_BROWSER_EXTENSION: dir }, "default"), dir);
});

test("the release guard finds local files, sourcemaps, key-shaped strings and the home directory", (t) => {
  const dir = tmp(t);
  const home = "/Users/someone";
  fs.mkdirSync(path.join(dir, "icons"));
  fs.writeFileSync(path.join(dir, "manifest.json"), "{}");
  fs.writeFileSync(path.join(dir, "background.js"), 'if (/^sk-ant-/.test(k)) provider = "anthropic";');
  assert.deepEqual(releaseProblems(dir, home), [], "a key's prefix alone is not a key");
  fs.writeFileSync(path.join(dir, "keys.local.json"), "{}");
  fs.writeFileSync(path.join(dir, "background.js.map"), "{}");
  fs.writeFileSync(path.join(dir, "icons", "a.json"), `"sk-ant-api03-${"x".repeat(40)}"`);
  fs.writeFileSync(path.join(dir, "sidepanel.js"), `const server = "${home}/drex/mcp/server.mjs";`);
  assert.deepEqual(
    releaseProblems(dir, home)
      .map((p) => path.relative(dir, p.split(":")[0]))
      .sort(),
    ["background.js.map", path.join("icons", "a.json"), "keys.local.json", "sidepanel.js"],
  );
});

test("runner credentials replace saved provider keys, including providers absent from the environment", () => {
  const saved = Object.fromEntries(Object.values(PROVIDERS).map((p) => [p.keyName, "saved-key"]));
  const over = overOf({ limits }, keysFrom({ DREX_API_KEY: "drex-env", OPENAI_API_KEY: "openai-env" }));
  const settings = { ...saved, ...over };
  assert.equal(missingKey(settings), "Anthropic", "the default model must not use a saved Anthropic key");
  assert.equal(settings.openaiKey, "openai-env");
  for (const { keyName } of Object.values(PROVIDERS))
    if (keyName !== "openaiKey") assert.equal(settings[keyName], "", keyName);
  assert.equal(missingKey({ ...settings, model: PROVIDERS.openai.defaultModel }), null);
  assert.equal(keysFrom({ DREX_API_KEY: "d", GEMINI_API_KEY: " g " }).googleKey, "g");
  for (const env of [{}, { ANTHROPIC_API_KEY: "a" }, { DREX_API_KEY: "d", ANTHROPIC_API_KEY: " " }])
    assert.throws(
      () => keysFrom(env),
      (e) => e.code === "missing_keys",
    );
});
