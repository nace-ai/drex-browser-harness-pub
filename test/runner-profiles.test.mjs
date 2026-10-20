// The runner's profiles (runner/src/profiles.mjs, runner/src/run.mjs): one run at a time per named profile, a dead
// holder's lock is taken over, and a temporary profile is removed on every way out of a run, a signal included.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import {
  ProfileBusy,
  keepTempCleanupLast,
  listProfiles,
  lockProfile,
  makeTempProfile,
  profileDir,
} from "../runner/src/profiles.mjs";
import { lookAt, runTask } from "../runner/src/run.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const BIN = path.join(ROOT, "runner/bin/nace-browser.mjs");
const DIST = path.join(ROOT, "dist");
const dirs = [];
after(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "nb-test-"));
  dirs.push(d);
  return d;
};
let keyless;
/** dist/ without its *.local.json (a dev build made with an .env holds keys.local.json, which the runner refuses). */
function extension() {
  if (keyless) return keyless;
  keyless = tmp();
  fs.cpSync(DIST, keyless, { recursive: true, filter: (src) => !src.endsWith(".local.json") });
  return keyless;
}
const fakeKeys = { DREX_API_KEY: "nace_sk_test", ANTHROPIC_API_KEY: "sk-ant-test" };

async function chromiumInstalled() {
  try {
    const { chromium } = await import("playwright");
    return fs.existsSync(chromium.executablePath());
  } catch {
    return false;
  }
}

test("a named profile is held by one process at a time", () => {
  const env = { NACE_BROWSER_HOME: tmp() };
  const release = lockProfile("work", { env, command: "run a" });
  assert.throws(
    () => lockProfile("work", { env }),
    (e) => e instanceof ProfileBusy && /pid \d+, run a/.test(e.message) && e.message.includes("work.lock"),
  );
  const other = lockProfile("home", { env }); // another profile is free
  release();
  release(); // twice is harmless
  lockProfile("work", { env })();
  other();
});

test("a lock left by a process that is gone is taken over", () => {
  const env = { NACE_BROWSER_HOME: tmp() };
  fs.mkdirSync(path.join(env.NACE_BROWSER_HOME, "profiles"), { recursive: true });
  const file = path.join(env.NACE_BROWSER_HOME, "profiles", "work.lock");
  fs.writeFileSync(file, JSON.stringify({ pid: 2 ** 30, host: os.hostname() })); // no such pid
  const release = lockProfile("work", { env });
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).pid, process.pid);
  release();
  assert.equal(fs.existsSync(file), false);
});

test("release() leaves a lock another process has taken over since", () => {
  const env = { NACE_BROWSER_HOME: tmp() };
  const release = lockProfile("work", { env });
  const file = path.join(env.NACE_BROWSER_HOME, "profiles", "work.lock");
  fs.writeFileSync(file, JSON.stringify({ pid: 2 ** 30, host: os.hostname() }));
  release();
  assert.equal(fs.existsSync(file), true);
});

test("a fresh takeover guard means another process is taking the lock over: busy", () => {
  const env = { NACE_BROWSER_HOME: tmp() };
  fs.mkdirSync(path.join(env.NACE_BROWSER_HOME, "profiles"), { recursive: true });
  const file = path.join(env.NACE_BROWSER_HOME, "profiles", "work.lock");
  fs.writeFileSync(file, JSON.stringify({ pid: 2 ** 30, host: os.hostname() })); // no such pid
  fs.writeFileSync(`${file}.takeover`, "1");
  assert.throws(() => lockProfile("work", { env }), ProfileBusy);
  assert.equal(fs.existsSync(`${file}.takeover`), true, "another process's fresh guard stays");
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).pid, 2 ** 30);
});

test("a takeover guard left over 10 s ago is removed: busy once, then the stale lock is taken over", () => {
  const env = { NACE_BROWSER_HOME: tmp() };
  fs.mkdirSync(path.join(env.NACE_BROWSER_HOME, "profiles"), { recursive: true });
  const file = path.join(env.NACE_BROWSER_HOME, "profiles", "work.lock");
  fs.writeFileSync(file, JSON.stringify({ pid: 2 ** 30, host: os.hostname() })); // no such pid
  fs.writeFileSync(`${file}.takeover`, "1");
  const old = new Date(Date.now() - 11000);
  fs.utimesSync(`${file}.takeover`, old, old);
  assert.throws(() => lockProfile("work", { env }), ProfileBusy);
  assert.equal(fs.existsSync(`${file}.takeover`), false);
  const release = lockProfile("work", { env });
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).pid, process.pid);
  release();
});

test("a lock with this process's pid that this process doesn't hold (a restarted container) is taken over", () => {
  const env = { NACE_BROWSER_HOME: tmp() };
  fs.mkdirSync(profileDir("work", env), { recursive: true });
  const file = path.join(env.NACE_BROWSER_HOME, "profiles", "work.lock");
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, host: os.hostname(), started: "earlier" }));
  assert.deepEqual(
    listProfiles(env).map((p) => [p.name, p.in_use]),
    [["work", false]],
  );
  const release = lockProfile("work", { env });
  assert.throws(() => lockProfile("work", { env }), ProfileBusy); // now this process holds it
  assert.deepEqual(
    listProfiles(env).map((p) => [p.name, p.in_use]),
    [["work", true]],
  );
  release();
  assert.equal(fs.existsSync(file), false);
});

test("on a case-insensitive disk, a held lock is busy under another case of its name", (t) => {
  const env = { NACE_BROWSER_HOME: tmp() };
  const release = lockProfile("work", { env });
  if (!fs.existsSync(path.join(env.NACE_BROWSER_HOME, "profiles", "WORK.lock"))) {
    release();
    return t.skip("needs a case-insensitive disk");
  }
  assert.throws(() => lockProfile("Work", { env }), ProfileBusy);
  release();
  lockProfile("Work", { env })();
});

test("another machine's lock (a shared home) is held, by lockProfile and in listProfiles", () => {
  const env = { NACE_BROWSER_HOME: tmp() };
  fs.mkdirSync(profileDir("work", env), { recursive: true });
  const file = path.join(env.NACE_BROWSER_HOME, "profiles", "work.lock");
  fs.writeFileSync(file, JSON.stringify({ pid: 2 ** 30, host: `${os.hostname()}-other` }));
  assert.throws(() => lockProfile("work", { env }), ProfileBusy);
  assert.deepEqual(
    listProfiles(env).map((p) => [p.name, p.in_use]),
    [["work", true]],
  );
});

test("processes that find the same stale lock at once: exactly one takes it over", async () => {
  const home = tmp();
  fs.mkdirSync(path.join(home, "profiles"), { recursive: true });
  const file = path.join(home, "profiles", "work.lock");
  fs.writeFileSync(file, JSON.stringify({ pid: 2 ** 30, host: os.hostname() })); // no such pid
  const go = Date.now() + 1500; // every child starts on the same tick, after its own start-up
  const child = () =>
    new Promise((resolve) => {
      const p = spawn(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `import { lockProfile } from ${JSON.stringify(path.join(ROOT, "runner/src/profiles.mjs"))};
           while (Date.now() < ${go});
           try { lockProfile("work"); process.stdout.write("got"); } catch (e) { process.stdout.write(e.code); }
           setTimeout(() => {}, 1500); // hold it while the others try`,
        ],
        { env: { ...process.env, NACE_BROWSER_HOME: home } },
      );
      let out = "";
      p.stdout.on("data", (d) => (out += d));
      p.on("exit", () => resolve(out));
    });
  const outs = await Promise.all(Array.from({ length: 6 }, child));
  assert.equal(outs.filter((o) => o === "got").length, 1, outs.join(" "));
  assert.equal(outs.filter((o) => o === "profile_busy").length, 5, outs.join(" "));
});

test("listProfiles shows each profile and whether a run holds it", () => {
  const env = { NACE_BROWSER_HOME: tmp() };
  assert.deepEqual(listProfiles(env), []);
  fs.mkdirSync(profileDir("a", env), { recursive: true });
  fs.mkdirSync(profileDir("b", env), { recursive: true });
  fs.mkdirSync(profileDir("c", env), { recursive: true });
  const release = lockProfile("b", { env });
  // a crashed run's lock on this machine: lockProfile would take it over
  fs.writeFileSync(
    path.join(env.NACE_BROWSER_HOME, "profiles", "c.lock"),
    JSON.stringify({ pid: 2 ** 30, host: os.hostname() }),
  );
  assert.deepEqual(
    listProfiles(env).map((p) => [p.name, p.in_use]),
    [
      ["a", false],
      ["b", true],
      ["c", false],
    ],
  );
  release();
});

test("a temporary profile is removed once, and process exit removes one a run never got to", async () => {
  const root = tmp();
  const t = makeTempProfile({ NACE_BROWSER_TMP: root });
  fs.writeFileSync(path.join(t.dir, "Cookies"), "x");
  t.remove();
  t.remove();
  assert.deepEqual(fs.readdirSync(root), []);
  // a process that exits with a temporary profile still in place (process.exit from a second Ctrl-C) removes it
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { makeTempProfile } from ${JSON.stringify(path.join(ROOT, "runner/src/profiles.mjs"))};
       makeTempProfile(); process.exit(143);`,
    ],
    { env: { ...process.env, NACE_BROWSER_TMP: root } },
  );
  assert.equal(await new Promise((r) => child.on("exit", r)), 143);
  assert.deepEqual(fs.readdirSync(root), []);
});

test("the exit hook that removes temporary profiles runs after exit listeners added before it is moved", () => {
  const root = tmp();
  const t = makeTempProfile({ NACE_BROWSER_TMP: root });
  const before = process.listeners("exit").length;
  const killer = () => {}; // stands in for Playwright's exit handler, added by launch()
  process.on("exit", killer);
  keepTempCleanupLast();
  keepTempCleanupLast();
  const listeners = process.listeners("exit");
  assert.equal(listeners.length, before + 1); // moved, not added again
  assert.ok(listeners.indexOf(killer) < listeners.length - 1);
  process.removeListener("exit", killer);
  t.remove();
});

test("a run on a temporary profile removes it when the run fails", { timeout: 90000 }, async (t) => {
  if (!fs.existsSync(path.join(DIST, "manifest.json"))) return t.skip("needs a built dist/ (npm run build)");
  const root = tmp();
  const env = { ...fakeKeys, NACE_BROWSER_HOME: tmp(), NACE_BROWSER_TMP: root, NACE_BROWSER_EXTENSION: extension() };
  // nothing listens on port 9: with Chromium installed the start page fails to load; without it the launch fails
  const opts = {
    task: "t",
    url: "http://127.0.0.1:9/",
    tempProfile: true,
    profile: null,
    limits: { maxCostUsd: 0.01, maxSeconds: 30, maxLlmCalls: 1 },
  };
  try {
    const r = await runTask(opts, { env });
    assert.equal(r.status, "failed");
  } catch (e) {
    if (await chromiumInstalled()) throw e; // with Chromium the run starts, and must end failed
    assert.match(e.code, /browser_missing|browser_failed/);
  }
  assert.deepEqual(fs.readdirSync(root), []);
});

test(
  "a run on a named profile keeps it, releases its lock, and can't start while another holds it",
  { timeout: 90000 },
  async (t) => {
    if (!fs.existsSync(path.join(DIST, "manifest.json"))) return t.skip("needs a built dist/ (npm run build)");
    const env = { ...fakeKeys, NACE_BROWSER_HOME: tmp(), NACE_BROWSER_EXTENSION: extension() };
    const opts = {
      task: "t",
      url: "http://127.0.0.1:9/", // nothing listens: the start page fails to load (or, without Chromium, the launch fails)
      profile: "work",
      limits: { maxCostUsd: 0.01, maxSeconds: 30, maxLlmCalls: 1 },
    };
    const held = lockProfile("work", { env, command: "run other" });
    await assert.rejects(runTask(opts, { env }), (e) => e.code === "profile_busy");
    held();
    try {
      assert.equal((await runTask(opts, { env })).status, "failed");
    } catch (e) {
      if (await chromiumInstalled()) throw e; // with Chromium the run starts, and must end failed
      assert.match(e.code, /browser_missing|browser_failed/);
    }
    assert.ok(fs.existsSync(profileDir("work", env)), "a named profile is never removed");
    assert.equal(fs.existsSync(path.join(env.NACE_BROWSER_HOME, "profiles", "work.lock")), false);
  },
);

for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"])
  test(
    `${signal} during a run's start-up cancels it and removes its temporary profile`,
    { timeout: 120000 },
    async (t) => {
      if (!(await chromiumInstalled()) || !fs.existsSync(path.join(DIST, "manifest.json")))
        return t.skip("needs Playwright's Chromium and a built dist/");
      const root = tmp();
      // a start page that never answers keeps the run in its start-up, where a signal must still clean up
      const hang = http.createServer(() => {});
      await new Promise((r) => hang.listen(0, "127.0.0.1", r));
      const url = `http://127.0.0.1:${hang.address().port}/`;
      const env = {
        ...process.env,
        ...fakeKeys,
        NACE_BROWSER_HOME: tmp(),
        NACE_BROWSER_TMP: root,
        NACE_BROWSER_EXTENSION: extension(),
      };
      const child = spawn(process.execPath, [BIN, "run", "t", "--url", url, "--temp-profile", "--json"], { env });
      let stdout = "";
      child.stdout.on("data", (d) => (stdout += d));
      const exited = new Promise((r) => child.on("exit", (code) => r(code)));
      for (let i = 0; i < 200 && !fs.readdirSync(root).length; i++) await new Promise((r) => setTimeout(r, 100));
      assert.equal(fs.readdirSync(root).length, 1, "the run made its profile");
      await new Promise((r) => setTimeout(r, 1500)); // Chromium is up and writing to it
      child.kill(signal);
      const code = await exited;
      hang.closeAllConnections();
      hang.close();
      // the runner's own handling, not Playwright's (which exits 130 on Ctrl-C before anything is printed): the start page
      // never loaded, so the run is cancelled before it started, and says so on stdout
      assert.equal(code, 3);
      assert.equal(JSON.parse(stdout).error.code, "cancelled");
      assert.deepEqual(fs.readdirSync(root), []);
    },
  );

test("lookAt counts only a visible CAPTCHA", { timeout: 60000 }, async (t) => {
  if (!(await chromiumInstalled())) return t.skip("needs Playwright's Chromium");
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ channel: "chromium" }); // the full Chromium: install skips the headless shell
  try {
    const page = await browser.newPage();
    const captchaOf = async (html) => {
      await page.setContent(`<title>Sign in</title>${html}`);
      return (await lookAt(page)).captcha;
    };
    // the badge an invisible reCAPTCHA shows on many sign-in pages
    assert.equal(
      await captchaOf(
        '<div class="grecaptcha-badge"><div class="g-recaptcha" style="width:256px;height:60px"></div></div>',
      ),
      false,
    );
    // an invisible reCAPTCHA bound to the submit button, and one whose badge is inline in its container
    assert.equal(await captchaOf('<button class="g-recaptcha" data-sitekey="k">Sign in</button>'), false);
    assert.equal(
      await captchaOf(
        '<div class="g-recaptcha" data-size="invisible" data-badge="inline">' +
          '<div class="grecaptcha-badge" style="width:256px;height:60px"></div></div>',
      ),
      false,
    );
    assert.equal(
      await captchaOf('<div class="g-recaptcha" style="display:none;width:300px;height:80px"></div>'),
      false,
    );
    assert.equal(
      await captchaOf('<div class="h-captcha" style="visibility:hidden;width:300px;height:80px"></div>'),
      false,
    );
    assert.equal(await captchaOf('<div class="g-recaptcha" style="width:300px;height:80px"></div>'), true);
    // a custom challenge's field for the characters it shows
    assert.equal(await captchaOf('<label>Enter the characters</label><input id="captcha">'), true);
    assert.equal((await lookAt(page)).title, "Sign in");
  } finally {
    await browser.close();
  }
});

test("lookAt gives up on a page that doesn't answer", { timeout: 20000 }, async () => {
  const stuck = { evaluate: () => new Promise(() => {}) };
  const t0 = Date.now();
  assert.deepEqual(await lookAt(stuck), {});
  const waited = Date.now() - t0;
  assert.ok(waited >= 4500 && waited < 7000, `waited ${waited} ms`);
});
