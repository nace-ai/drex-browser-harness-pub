// runTask's hosted stops without a real Chromium: a funding stop while Chromium starts, and the needs_user look that
// a run without an end screenshot still takes.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runTask } from "../runner/src/run.mjs";
import { chromium } from "playwright";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "run-hosted-stop-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const extension = path.join(root, "extension");
  await fs.mkdir(extension);
  await fs.writeFile(path.join(extension, "manifest.json"), "{}");
  return {
    root,
    env: {
      DREX_API_KEY: "fixture",
      ANTHROPIC_API_KEY: "fixture",
      NACE_BROWSER_EXTENSION: extension,
      NACE_BROWSER_HOME: path.join(root, "home"),
      NACE_BROWSER_TMP: path.join(root, "tmp"),
    },
    opts: {
      task: "t",
      url: "http://site.test/",
      tempProfile: true,
      out: path.join(root, "out"),
      limits: { maxSeconds: 60 },
    },
  };
}

test("a funding stop while Chromium starts ends the run at once and closes the browser once it is up", async (t) => {
  const { env, opts } = await fixture(t);
  const stop = new AbortController();
  let up;
  let closed = false;
  let cleanups = 0;
  const launching = new Promise((resolve) => (up = resolve));
  // a failed assertion must not leave the launch, and the kill loop polling it, pending forever
  t.after(() => up({ close: async () => {} }));
  t.mock.method(chromium, "launchPersistentContext", () => launching);
  setTimeout(() => stop.abort(), 50);
  const t0 = performance.now();
  await assert.rejects(
    runTask(opts, {
      env,
      signal: stop.signal,
      killSignal: stop.signal,
      onCleanup: () => cleanups++,
      handleSignals: false,
    }),
    { code: "cancelled" },
  );
  assert.ok(performance.now() - t0 < 2000, "the stop waited for Chromium to start");
  assert.equal(cleanups, 1);
  // Chromium writes to its profile until it is gone: the profile stays until the late browser has closed
  assert.equal((await fs.readdir(env.NACE_BROWSER_TMP)).length, 1, "the profile was removed under a live browser");
  up({ close: async () => (closed = true) });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(closed, true, "the late browser is closed");
  assert.deepEqual(await fs.readdir(env.NACE_BROWSER_TMP), [], "the late browser's profile was kept");
});

test("a run without an end screenshot still looks for a CAPTCHA on a hand-over", async (t) => {
  const { env, opts } = await fixture(t);
  let shots = 0;
  const pages = [];
  const page = (onEvaluate) => {
    const p = {
      at: "about:blank",
      goto: async (url) => void (p.at = url),
      url: () => p.at,
      isClosed: () => false,
      close: async () => {},
      bringToFront: async () => {},
      screenshot: async () => void shots++,
      evaluate: async (fn) => onEvaluate(String(fn)),
    };
    pages.push(p);
    return p;
  };
  const user = page(() => ({ title: "Just a moment", captcha: true }));
  const ctx = {
    serviceWorkers: () => [{ url: () => "chrome-extension://ext/background.js" }],
    pages: () => pages,
    newPage: async () =>
      page((fn) => {
        if (fn.includes("slice(seen)"))
          return { events: [], running: false, started: true, refused: null, gone: false };
        if (fn.includes("lastRun ??"))
          return { status: "needs_user", message: "Finish this step, then continue.", report: { url: user.url() } };
        return undefined;
      }),
    close: async () => {},
  };
  t.mock.method(chromium, "launchPersistentContext", async () => ctx);
  const result = await runTask(opts, { env, endScreen: false, handleSignals: false });
  assert.equal(result.outcome.kind, "blocked_captcha");
  assert.equal(shots, 0);
});

// a renderer-like helper in the browser's process group, which carries no --user-data-dir of its own
const browser = `const h = require("child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
  stdio: "ignore",
});
console.log(h.pid);
setInterval(() => {}, 1000);`;

const gone = async (pid) => {
  for (let i = 0; i < 30; i++) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
};

for (const which of ["signal", "killSignal"])
  test(
    `a ${which} stop kills Chromium and its helpers while its launch is still pending, and no other profile's browser`,
    { skip: !["linux", "darwin"].includes(process.platform) },
    async (t) => {
      const { env, opts } = await fixture(t);
      const stop = new AbortController();
      let child;
      let other;
      let helper;
      let exited;
      let started;
      const ready = new Promise((resolve) => (started = resolve));
      t.mock.method(
        chromium,
        "launchPersistentContext",
        (dir) =>
          new Promise((_resolve, reject) => {
            // another run's browser whose profile path starts with this one's
            other = spawn(
              process.execPath,
              ["-e", "setInterval(() => {}, 1000)", "--", `--user-data-dir=${dir}-other`],
              {
                detached: true,
                stdio: "ignore",
              },
            );
            child = spawn(process.execPath, ["-e", browser, "--", `--user-data-dir=${dir}`], {
              detached: true,
              stdio: ["ignore", "pipe", "ignore"],
            });
            exited = new Promise((resolve) =>
              child.once("exit", () => {
                resolve();
                reject(new Error("Browser closed"));
              }),
            );
            child.stdout.once("data", (line) => started((helper = Number(String(line).trim()))));
          }),
      );
      t.after(() => {
        for (const pid of [child?.pid, helper, other?.pid].filter(Boolean))
          try {
            process.kill(pid, "SIGKILL");
          } catch {}
      });
      const run = runTask(opts, { env, handleSignals: false, [which]: stop.signal });
      await ready;
      stop.abort();
      await assert.rejects(run, { code: "cancelled" });
      let timer;
      try {
        await Promise.race([
          exited,
          new Promise((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error("Chromium kept running after stop")), 3000);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
      assert.ok(await gone(helper), "a helper in Chromium's process group kept running");
      assert.equal(other.exitCode, null, "another profile's browser was killed");
      assert.equal(other.signalCode, null, "another profile's browser was killed");
    },
  );
