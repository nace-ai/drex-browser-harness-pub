import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { test } from "node:test";
import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { MODE, loopMode } from "../src/mode.ts";

test("the default build has no run mode: MODE is empty and the agent runs", () => {
  assert.equal(MODE, "");
  assert.equal(loopMode(), false);
});

test("a build defined with DREX_MODE=loop runs the loop", async () => {
  const dir = await mkdtemp(join(tmpdir(), "drex-mode-"));
  try {
    await build({
      entryPoints: [fileURLToPath(new URL("../src/mode.ts", import.meta.url))],
      outdir: dir,
      bundle: true,
      platform: "node",
      format: "esm",
      define: { __DREX_MODE__: '"loop"' },
    });
    const bundled = await import(pathToFileURL(join(dir, "mode.js")));
    assert.equal(bundled.MODE, "loop");
    assert.equal(bundled.loopMode(), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// build.mjs judges its mode before it touches anything, so a build it refuses leaves dist/ and runner/extension/ as they were
const root = fileURLToPath(new URL("..", import.meta.url));
const tried = (mode, ...args) =>
  spawnSync(process.execPath, ["build.mjs", ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, DREX_MODE: mode },
  });
const manifest = join(root, "dist", "manifest.json");
const stamp = (file = manifest) => (existsSync(file) ? statSync(file).mtimeMs : null);

test("a build refuses a DREX_MODE that is neither empty nor loop, and names it", () => {
  const before = stamp();
  for (const mode of ["lop", "LOOP", "Loop", " loop", "loop ", "default", "agent"]) {
    const r = tried(mode);
    assert.equal(r.status, 1, JSON.stringify(mode));
    assert.match(r.stderr, /DREX_MODE must be empty or "loop"/, JSON.stringify(mode));
    assert.ok(r.stderr.includes(JSON.stringify(mode)), r.stderr);
    assert.ok(!/^built /m.test(r.stdout), r.stdout);
  }
  assert.equal(stamp(), before); // dist/ was not rebuilt
});

test("a release build refuses the loop mode, which is for evals until its read sandbox lands", () => {
  // CI builds a release before the tests run, so the file may be there: the refused build must leave it as it was
  const file = join(root, "runner", "extension", "background.js");
  const exists = existsSync(file);
  const mtime = stamp(file);
  const r = tried("loop", "--release");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /loop mode is eval-only/);
  assert.match(r.stderr, /--release/);
  assert.equal(
    existsSync(file),
    exists,
    "a refused release build changed whether runner/extension/background.js exists",
  );
  assert.equal(stamp(file), mtime, "a refused release build rewrote runner/extension/background.js");
});

// Exercise the bundled worker through the panel boundary. The optional web tab reaches agent-specific behavior,
// then the fake debugger refuses attachment so no model request can be made.
async function lastRunOf(define, withTab = false) {
  const dir = await mkdtemp(join(tmpdir(), "drex-worker-"));
  const listeners = {};
  const event = (name) => ({
    addListener: (fn) => (listeners[name] = fn),
    removeListener() {},
  });
  const keys = {
    drexKey: "d",
    anthropicKey: "a",
    openaiKey: "o",
    fireworksKey: "f",
    googleKey: "g",
    openrouterKey: "r",
  };
  const previous = globalThis.chrome;
  try {
    await build({
      entryPoints: [fileURLToPath(new URL("../src/background.ts", import.meta.url))],
      outfile: join(dir, "background.mjs"),
      bundle: true,
      platform: "node",
      format: "esm",
      // the AI SDK reads node's own modules with require
      banner: {
        js: 'import { createRequire as __nodeRequire } from "node:module"; const require = __nodeRequire(import.meta.url);',
      },
      define,
      logLevel: "error",
    });
    globalThis.chrome = {
      runtime: {
        id: "ext",
        onConnect: event("connect"),
        onStartup: event("startup"),
        getPlatformInfo: async () => ({}),
      },
      sidePanel: { setPanelBehavior: async () => {} },
      notifications: { onButtonClicked: event("button"), onClicked: event("click"), clear: () => {} },
      storage: {
        onChanged: event("changed"),
        local: {
          get: async (k) => Object.fromEntries([k].flat().flatMap((x) => (x in keys ? [[x, keys[x]]] : []))),
          set: async () => {},
          remove: async () => {},
        },
      },
      alarms: { onAlarm: event("alarm"), create: () => {}, clear: () => {} },
      windows: { getLastFocused: async () => ({ id: 1 }) },
      tabs: {
        query: async () => {
          if (withTab) return [{ id: 11, active: true, url: "https://shop.example/orders", title: "Orders" }];
          throw new Error("no tabs in this test");
        },
        get: async () => ({ id: 11, url: "https://shop.example/orders" }),
        onCreated: event("created"),
      },
      debugger: {
        onDetach: event("detach"),
        onEvent: event("debuggerEvent"),
        attach: async () => {
          throw new Error("debugger unavailable in this test");
        },
        detach: async () => {},
      },
    };
    await import(pathToFileURL(join(dir, "background.mjs")));
    const sent = [];
    let onMessage;
    listeners.connect({
      name: "panel",
      sender: { id: "ext" },
      postMessage: (m) => sent.push(m),
      onDisconnect: { addListener() {} },
      onMessage: { addListener: (fn) => (onMessage = fn) },
    });
    await onMessage({ type: "run", task: "Find the total of the orders", over: { planning: false } });
    await onMessage({ type: "lastRun" });
    return { ...sent.find((m) => m.type === "lastRun").run, workerEvents: sent.filter((m) => m.type === "event") };
  } finally {
    globalThis.chrome = previous;
    delete globalThis.drexState;
    await rm(dir, { recursive: true, force: true });
  }
}

test("the worker's record of the last run says which mode the build is in, so a run's artifacts show it", async (t) => {
  t.mock.method(console, "error", () => {});
  const plain = await lastRunOf({});
  assert.equal(plain.mode, "");
  assert.equal(plain.status, "error");
  assert.equal(plain.message, "no tabs in this test");
  assert.equal(plain.planning, false); // the record's other fields are still there
  assert.equal((await lastRunOf({ __DREX_MODE__: '"loop"' })).mode, "loop");
});

test("the bundled worker selects the loop agent only for the loop build", async (t) => {
  t.mock.method(console, "error", () => {});
  const plain = await lastRunOf({}, true);
  const loop = await lastRunOf({ __DREX_MODE__: '"loop"' }, true);
  assert.ok(
    plain.workerEvents.some((m) => m.event === "plan"),
    "default agent must execute its planning path",
  );
  assert.ok(!plain.workerEvents.some((m) => m.event === "tab" && m.data.what === "Loop: reading the page"));
  assert.ok(loop.workerEvents.some((m) => m.event === "tab" && m.data.what === "Loop: reading the page"));
  assert.ok(!loop.workerEvents.some((m) => m.event === "plan"), "loop agent must bypass the default planning path");
  assert.equal(loop.status, "error");
  assert.equal(loop.message, "debugger unavailable in this test");
});
