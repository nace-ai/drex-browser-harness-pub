// Cancellation must keep the profile locked until Chromium has actually finished closing.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const loginUrl = new URL("../runner/src/login.mjs", import.meta.url).href;
const cliUrl = new URL("../runner/src/cli.mjs", import.meta.url).href;

function child(script) {
  return spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 10000 });
}

for (const when of ["navigation", "launch"])
  test(`login cancelled during ${when} holds its lock until browser shutdown finishes`, () => {
    const r = child(`
      import assert from "node:assert/strict";
      import fs from "node:fs";
      import os from "node:os";
      import path from "node:path";
      import { registerHooks } from "node:module";
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "nb-login-"));
      const controller = new AbortController();
      let finishClose, startedClose;
      const closing = new Promise(r => finishClose = r);
      const started = new Promise(r => startedClose = r);
      let isClosing = false;
      const page = { on() {}, async goto() { controller.abort(); } };
      globalThis.launchLogin = async () => {
        if (${JSON.stringify(when)} === "launch") controller.abort();
        return {
          pages: () => [page], on() {},
          async close() {
            // Playwright ignores subsequent close calls while the first is in progress.
            if (isClosing) return;
            isClosing = true;
            startedClose();
            await closing;
          }
        };
      };
      const mock = "data:text/javascript," + encodeURIComponent(
        "export class RunnerError extends Error {} export const launch = globalThis.launchLogin;"
      );
      registerHooks({ resolve(specifier, context, next) {
        if (specifier === "./run.mjs" && context.parentURL === ${JSON.stringify(loginUrl)})
          return { url: mock, shortCircuit: true };
        return next(specifier, context);
      }});
      const { login } = await import(${JSON.stringify(loginUrl)});
      let settled = false;
      const result = login({url: "https://example.test", profile: "work"}, {
        env: {NACE_BROWSER_HOME: home, DISPLAY: ":0"}, signal: controller.signal
      }).then(r => { settled = true; return r; });
      try {
        await started;
        await new Promise(r => setImmediate(r));
        assert.equal(settled, false, "login returned before shutdown completed");
        assert.ok(fs.existsSync(path.join(home, "profiles/work.lock")), "lock released during shutdown");
      } finally {
        finishClose();
        await result;
        assert.equal(fs.existsSync(path.join(home, "profiles/work.lock")), false);
        fs.rmSync(home, { recursive: true, force: true });
      }
      assert.equal((await result).ended, "cancelled");
    `);
    assert.equal(r.status, 0, r.stderr || String(r.error));
  });

test("the CLI reports a cancelled login as unsuccessful, without claiming it saved the session", () => {
  const r = child(`
    import { registerHooks } from "node:module";
    registerHooks({ resolve(specifier, context, next) {
      if (specifier === "./login.mjs" && context.parentURL === ${JSON.stringify(cliUrl)})
        return { url: "data:text/javascript,export const login = async () => ({ended: 'cancelled'});", shortCircuit: true };
      return next(specifier, context);
    }});
    const { main } = await import(${JSON.stringify(cliUrl)});
    process.exitCode = await main(["login", "https://example.test"]);
  `);
  assert.equal(r.status, 3, r.stderr || String(r.error));
  assert.match(r.stderr, /Login cancelled/);
  assert.doesNotMatch(r.stderr, /Saved/);
});

test("a login cancelled before it starts opens no window and holds no lock", () => {
  const r = child(`
    import assert from "node:assert/strict";
    import fs from "node:fs";
    import os from "node:os";
    import path from "node:path";
    import { registerHooks } from "node:module";
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nb-login-"));
    let launched = false;
    globalThis.launchLogin = async () => { launched = true; throw new Error("launched"); };
    const mock = "data:text/javascript," + encodeURIComponent(
      "export class RunnerError extends Error {} export const launch = globalThis.launchLogin;"
    );
    registerHooks({ resolve(specifier, context, next) {
      if (specifier === "./run.mjs" && context.parentURL === ${JSON.stringify(loginUrl)})
        return { url: mock, shortCircuit: true };
      return next(specifier, context);
    }});
    const { login } = await import(${JSON.stringify(loginUrl)});
    try {
      const r = await login({url: "https://example.test", profile: "work"}, {
        env: {NACE_BROWSER_HOME: home, DISPLAY: ":0"}, signal: AbortSignal.abort()
      });
      assert.equal(r.ended, "cancelled");
      assert.equal(launched, false);
      assert.equal(fs.existsSync(path.join(home, "profiles/work.lock")), false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  `);
  assert.equal(r.status, 0, r.stderr || String(r.error));
});
