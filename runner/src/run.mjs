// One run: Playwright's Chromium with the release build of the extension, on a saved profile. The run itself happens
// in the extension's service worker, exactly as a run from the side panel does; the runner opens the panel page (an
// extension page, the only kind the worker takes runs from), sends it the task over the panel's port with this run's
// keys, model and limits, and waits for the worker's result. Ported from e2e/run.py, which drives the same loop
// through the panel's buttons.
import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ProfileBusy, home, keepTempCleanupLast, lockProfile, makeTempProfile, profileDir } from "./profiles.mjs";
import { resultOf } from "./result.mjs";
import { connectTransport, restrictPages } from "./worker-transport.mjs";
import { browserProxy } from "./worker-network.mjs";

export class RunnerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "RunnerError";
    this.code = code;
  }
}

/** The error code a caller gets: the runner's own, or runner_error (not a system error's EACCES or ENOENT). */
export const codeOf = (e) => (e instanceof RunnerError || e instanceof ProfileBusy ? e.code : "runner_error");

/** The environment variable of each key, as the extension's settings name it (src/settings.ts, build.mjs). */
export const KEY_ENV = Object.freeze({
  drexKey: ["DREX_API_KEY"],
  anthropicKey: ["ANTHROPIC_API_KEY"],
  openaiKey: ["OPENAI_API_KEY"],
  fireworksKey: ["FIREWORKS_API_KEY"],
  googleKey: ["GOOGLE_API_KEY", "GEMINI_API_KEY"],
  openrouterKey: ["OPENROUTER_API_KEY"],
});

/** The keys set in the environment. They go to the extension with the run, never to its storage or to disk. */
export function keysFrom(env = process.env) {
  const keys = {};
  for (const [name, vars] of Object.entries(KEY_ENV)) {
    const value = vars.map((v) => (env[v] ?? "").trim()).find(Boolean);
    if (value) keys[name] = value;
  }
  if (!keys.drexKey)
    throw new RunnerError(
      "missing_keys",
      "Set DREX_API_KEY: a Drex API key from https://console.nace.ai/dashboard/api-keys.",
    );
  if (Object.keys(keys).length === 1)
    throw new RunnerError(
      "missing_keys",
      "Set the LLM's key: ANTHROPIC_API_KEY for the default model (or OPENAI_API_KEY, GOOGLE_API_KEY or GEMINI_API_KEY, OPENROUTER_API_KEY or FIREWORKS_API_KEY with --model).",
    );
  return keys;
}

/**
 * The unpacked extension the runner loads: the package's release build, or NACE_BROWSER_EXTENSION (a dev build).
 * Not one with keys.local.json (a dev build made with an .env): the extension saves those keys into the profile's
 * storage, and the runner's keys must never reach the disk.
 */
export function extensionDir(env = process.env) {
  const dir = env.NACE_BROWSER_EXTENSION
    ? path.resolve(env.NACE_BROWSER_EXTENSION)
    : fileURLToPath(new URL("../extension", import.meta.url));
  if (!fs.existsSync(path.join(dir, "manifest.json")))
    throw new RunnerError(
      "extension_missing",
      `No extension build at ${dir}. In a checkout, run \`npm run build:release\` first.`,
    );
  if (fs.existsSync(path.join(dir, "keys.local.json")))
    throw new RunnerError(
      "extension_has_keys",
      `${dir} holds keys.local.json, which the extension would save into the profile. Unset ` +
        "NACE_BROWSER_EXTENSION to use the release build, or rebuild that one without an .env.",
    );
  return dir;
}

// told to the planner, Drex and the helper, as src/bridge.ts tells them for a coding agent's run: report what the page
// did instead of retrying a broken page
const FROM_AGENT =
  "(Asked by a coding agent. If the page doesn't respond the way the task expects after a fair try, " +
  "for example nothing happens after a button is clicked twice, don't keep retrying: give up and say exactly what the page did. For a test, that is the result.)";

const START_WAIT_MS = 30000; // from the run message to the worker's "running"
const WORKER_WAIT_MS = 60000; // e2e/run.py: with several Chromiums starting at once the worker can take over 15 s
const GRACE_MS = 60000; // past max_seconds before the runner stops the run itself (the agent's own limit stops it first)
const STOP_WAIT_MS = 30000;
const POLL_MS = 500;

/** src/models.ts DEFAULT_MODEL. Sent when the caller names no model: else a model picked in a headed run's panel, saved in
 * the profile, would be used for later runs (and its higher default cost cap with it). */
export const DEFAULT_MODEL = "claude-haiku-5-5";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * What the runner sends the extension with the run: the environment's keys, the limits (no cost limit unless the
 * caller set one: the extension scales its default to the model), and risky clicks denied unless a person allowed them
 * with --allow-risky.
 */
export function overOf(opts, keys) {
  return {
    // every key named, an unset one as "": the worker lays this over the profile's saved settings, and a key saved
    // there (typed in a headed run's panel) must not stand in for one the environment doesn't set
    ...Object.fromEntries(Object.keys(KEY_ENV).map((name) => [name, ""])),
    ...keys,
    runLimits: {
      ...(opts.limits.maxCostUsd === undefined ? {} : { maxCostUsd: opts.limits.maxCostUsd }),
      // endsAt: a caller's own deadline, which the time spent starting the browser has already used part of
      maxSeconds: opts.endsAt
        ? Math.max(1, Math.min(opts.limits.maxSeconds, Math.floor((opts.endsAt - Date.now()) / 1000)))
        : opts.limits.maxSeconds,
      maxHaikuCalls: opts.limits.maxLlmCalls,
    },
    approvals: !opts.allowRisky,
    report: { expect: "" }, // a hand-over ends the run (nobody is at this browser) and the end screen is reported
    notify: false,
    model: opts.model || DEFAULT_MODEL,
  };
}
export const newRunId = () => `lrun_${Date.now().toString(36)}${crypto.randomBytes(4).toString("hex")}`;

/**
 * Launches Playwright's Chromium on a profile. extension: the unpacked extension to load, or null (login).
 * handleSignals: false when the caller handles Ctrl-C and SIGTERM itself (the CLI stops the run and prints its result);
 * Playwright's own handlers would close the browser under the run, and exit on Ctrl-C before the result is printed.
 * proxy: the worker's origin proxy. The browser is then restricted: no site service workers, and none of the worker's
 * keys or callback secret in its processes' environment.
 */
export async function launch(userDataDir, { headless, extension, handleSignals = true, proxy }) {
  const { chromium } = await import("playwright");
  // e2e/run.py: no viewport emulation. A real 1280x800 page plus the toolbar, so the agent's screenshots always match
  // the page's innerWidth/innerHeight (under emulation a front tab's screenshot was cropped or stale). Planned runs
  // use a 2x pixel ratio, as the extension's eval does.
  const args = ["--window-size=1280,939", "--force-device-scale-factor=2"];
  if (extension) args.push(`--disable-extensions-except=${extension}`, `--load-extension=${extension}`);
  if (proxy)
    args.push(
      `--proxy-server=${proxy}`,
      "--proxy-bypass-list=<-loopback>",
      "--disable-quic",
      "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
    );
  try {
    return await chromium.launchPersistentContext(userDataDir, {
      channel: "chromium", // the full Chromium: the headless shell can't load extensions
      headless,
      viewport: null,
      args,
      handleSIGINT: handleSignals,
      handleSIGTERM: handleSignals,
      handleSIGHUP: handleSignals,
      ...(proxy
        ? {
            serviceWorkers: "block",
            env: Object.fromEntries(
              Object.entries(process.env).filter(([name]) => !/^(DREX_|E2B_)|_API_KEY$|SECRET|TOKEN/i.test(name)),
            ),
          }
        : {}),
    });
  } catch (e) {
    const msg = String(e?.message ?? e);
    if (/Executable doesn't exist|browserType\.launch.*install/i.test(msg))
      throw new RunnerError(
        "browser_missing",
        "Playwright's Chromium is not installed: run `nace-browser install` (or `npx -y @nace-ai/browser install`).",
      );
    if (/ProcessSingleton|SingletonLock|profile.*in use/i.test(msg))
      throw new RunnerError("profile_busy", "Another Chromium has this profile open. Close it and try again.");
    throw new RunnerError("browser_failed", `Chromium did not start: ${msg.split("\n")[0]}`);
  }
}

/** What the agent's tab shows, to tell a sign-in from a CAPTCHA when the run handed the screen over. */
export async function lookAt(page) {
  let timer;
  try {
    const look = page.evaluate(() => ({
      title: document.title,
      // a challenge on screen: an invisible reCAPTCHA (on many sign-in pages: its badge, its container, or the submit
      // button or link it is bound to) and hidden elements don't count; its challenge, when it shows one, is an iframe of
      // its own. A text field for a CAPTCHA's characters does count
      captcha: [
        ...document.querySelectorAll(
          'iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="challenges.cloudflare.com"], ' +
            '.cf-turnstile, .g-recaptcha, .h-captcha, [id*="captcha" i], [class*="captcha" i]',
        ),
      ].some((el) => {
        if (
          el.closest('.grecaptcha-badge, [data-size="invisible"]') ||
          el.matches('button, a, input[type="submit" i], input[type="button" i], input[type="image" i]')
        )
          return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden";
      }),
    }));
    // a page stuck in a script never answers, and the result must not wait for it
    const late = new Promise((r) => (timer = setTimeout(() => r({}), 5000)));
    return await Promise.race([look, late]);
  } catch {
    return {};
  } finally {
    clearTimeout(timer);
  }
}

/** The tab the agent left: the one at its end screen's URL, or the last web page open. */
function agentPage(ctx, url) {
  const pages = ctx.pages().filter((p) => !p.isClosed() && /^https?:/.test(p.url()));
  return pages.find((p) => p.url() === url) ?? pages.at(-1) ?? null;
}

const clip = (text, n = 80) => (String(text).length > n ? `${String(text).slice(0, n - 1)}…` : String(text));

/** One line of progress for an event of the run's log, or null for an event nobody needs to see. */
export function progressLine(type, e) {
  switch (type) {
    case "plan":
      return Array.isArray(e.plan?.steps)
        ? `${e.replanned ? "new plan" : "plan"}: ${e.plan.steps.map((s, i) => `${i + 1}. ${clip(s.goal ?? s.kind)}`).join(" ")}`
        : null;
    case "step":
      return `step ${Number(e.index) + 1} ${e.status}`;
    case "move":
      return `${e.who === "drex" ? "Drex" : e.who === "macro" ? "macro" : "LLM"}: ${e.what}${e.effect ? ` -> ${e.effect}` : ""}`;
    case "tab":
    case "blocked":
    case "skipped":
      return `${type}: ${e.what ?? ""}${e.reason ? ` (${e.reason})` : ""}`;
    case "finish":
      return `finished: ${e.status}${e.message ? ` (${e.message})` : ""}`;
    default:
      return null;
  }
}

/**
 * Runs one task. opts: {task, url, profile, tempProfile, headed, limits {maxCostUsd, maxSeconds, maxLlmCalls}, model,
 * allowRisky, out, allowedOrigins, endsAt}. tempProfile: a fresh profile, deleted when the run ends (profile is then ignored). onProgress(line) gets a line per move. signal: aborting it stops the run (it ends "cancelled"). handleSignals: see launch().
 * Returns the result (resultOf's shape). Throws RunnerError for what stops a run from starting.
 */
export async function runTask(
  opts,
  { env = process.env, onProgress = () => {}, signal, handleSignals = true, transport, allowLocal = false } = {},
) {
  const keys = keysFrom(env);
  const extension = extensionDir(env);
  const id = newRunId();
  const created = new Date().toISOString();
  const out = path.resolve(opts.out ?? path.join(home(env), "runs", id));
  // a temporary profile is this run's alone: no lock. A named one is locked, one run at a time.
  const temp = opts.tempProfile ? makeTempProfile(env) : null;
  const release = temp ? () => {} : lockProfile(opts.profile, { env, command: `run ${id}` });
  let ctx = null;
  let network = null;
  let polling = false;
  // one close for the abort and the finally: a second ctx.close() returns before the first has finished, and a temporary
  // profile removed then is written back by the Chromium still shutting down
  let closing = null;
  const close = () => (closing ??= ctx.close().catch(() => {}));
  // a cancel before the run has started (Chromium starting, the start page loading) closes the browser at once; once
  // the run is going, the loop below asks the agent to stop so its result is kept
  const onAbort = () => {
    if (!polling && ctx) void close();
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    if (signal?.aborted) throw new RunnerError("cancelled", "The run was cancelled before it started.");
    fs.mkdirSync(out, { recursive: true });
    const dir = temp ? temp.dir : profileDir(opts.profile, env);
    fs.mkdirSync(dir, { recursive: true });
    if (transport) network = await browserProxy(opts.allowedOrigins, { allowLocal });
    ctx = await launch(dir, {
      headless: !opts.headed,
      extension,
      handleSignals,
      proxy: network?.url,
    });
    if (transport) await restrictPages(ctx, opts.allowedOrigins);
    // a forced exit (a second Ctrl-C) removes the temporary profile after Playwright's exit handler, registered by
    // launch(), has killed Chromium: removed before that, Chromium can write parts of it back
    if (temp) keepTempCleanupLast();
    if (signal?.aborted) throw new RunnerError("cancelled", "The run was cancelled before it started.");
    // the extension's worker, not a site's: a saved profile's restored tabs can start their sites' workers first
    const ours = (w) => w.url().startsWith("chrome-extension://");
    const sw =
      ctx.serviceWorkers().find(ours) ??
      (await ctx.waitForEvent("serviceworker", { predicate: ours, timeout: WORKER_WAIT_MS }));
    const extId = new URL(sw.url()).host;
    // Install the trusted model channel before any untrusted page is loaded.
    const transportPanel = transport ? await ctx.newPage() : null;
    if (transportPanel) {
      await transportPanel.goto(`chrome-extension://${extId}/sidepanel.html`);
      await connectTransport(transportPanel, sw, transport);
    }
    // a saved profile may reopen tabs: the run starts from one tab on the start page
    const user = ctx.pages().find((p) => p !== transportPanel) ?? (await ctx.newPage());
    for (const p of ctx.pages()) if (p !== user && p !== transportPanel) await p.close().catch(() => {});
    const started = new Date().toISOString();
    try {
      await user.goto(opts.url, { waitUntil: "domcontentloaded", timeout: 45000 });
    } catch (e) {
      // a cancel while the start page loads closes the browser under goto(): that is a cancel, not the site failing
      if (signal?.aborted) throw new RunnerError("cancelled", "The run was cancelled before it started.");
      const run = { status: "failed", message: `Could not open ${opts.url}: ${String(e.message).split("\n")[0]}` };
      return await finish({ run, out, id, opts, created, started, page: null, ended: null });
    }
    const panel = await ctx.newPage();
    await panel.goto(`chrome-extension://${extId}/sidepanel.html`);
    await user.bringToFront(); // the start page is the active tab when the task starts, as in real use
    const over = overOf(opts, keys);
    await panel.evaluate(
      ({ task, over }) => {
        const quiet = new Set(["screen", "aim", "busy", "totals"]);
        // started: the worker said "running" at least once (a run that ends within one poll still counts as started)
        // gone: the port closed (the worker stopped), so no "running" or result will come
        const state = { events: [], running: null, started: false, refused: null, lastRun: undefined, gone: false };
        const port = chrome.runtime.connect({ name: "panel" });
        port.onDisconnect.addListener(() => (state.gone = true));
        port.onMessage.addListener((m) => {
          if (m.type === "event" && !quiet.has(m.event)) {
            const { image: _i, shot: _s, ...data } = m.data ?? {};
            state.events.push([m.event, data]);
          } else if (m.type === "running") {
            state.running = m.on;
            if (m.on) state.started = true;
          } else if (m.type === "refused") state.refused = m;
          else if (m.type === "lastRun") state.lastRun = m.run;
        });
        globalThis.naceRunner = { state, send: (m) => port.postMessage(m) };
        port.postMessage({ type: "run", task, windowId: undefined, over });
      },
      { task: `${opts.task}\n${FROM_AGENT}`, over },
    );
    const read = (seen) =>
      panel.evaluate((seen) => {
        const s = globalThis.naceRunner.state;
        return {
          events: s.events.slice(seen),
          running: s.running,
          started: s.started,
          refused: s.refused,
          gone: s.gone,
        };
      }, seen);
    const send = (m) => panel.evaluate((m) => globalThis.naceRunner.send(m), m).catch(() => {});

    polling = true;
    let seen = 0;
    let ended = null;
    const t0 = Date.now();
    const deadline = t0 + opts.limits.maxSeconds * 1000 + GRACE_MS;
    let stopAt = null;
    let startSeen = false;
    // the browser, the panel or the worker went away mid-run: the run's own result is lost. The run was sent, so it may have started
    // (and acted) between two polls even if no poll saw it: its result still says it failed
    let lost = null;
    for (;;) {
      let s;
      try {
        s = await read(seen);
      } catch (e) {
        lost = String(e?.message ?? e).split("\n")[0];
        break;
      }
      for (const [type, data] of s.events) {
        const line = progressLine(type, data);
        if (line) onProgress(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s] ${line}`);
      }
      seen += s.events.length;
      if (s.gone) {
        lost = "the extension's worker stopped";
        break;
      }
      // a refusal once the run has started is the agent failing mid-run (the worker reports its error the same way):
      // the run ends, and its result says internal_error
      if (s.refused && !s.started) {
        if (s.refused.why === "keys")
          throw new RunnerError(
            "missing_keys",
            `The extension has no key for the model${opts.model ? ` ${opts.model}` : ""}: set its provider's API key.`,
          );
        if (s.refused.why === "busy") throw new RunnerError("busy", "The extension is already running a task.");
        throw new RunnerError("run_refused", s.refused.message ?? "The extension refused the run.");
      }
      // a stop sent before the worker had made its agent was not heard: send it again now the run has started
      if (s.started && !startSeen && stopAt !== null) {
        await send({ type: "stop" });
        stopAt = Date.now();
      }
      startSeen ||= s.started;
      if (s.started && s.running === false) break;
      if (!s.started && Date.now() - t0 > START_WAIT_MS)
        throw signal?.aborted
          ? new RunnerError("cancelled", "The run was cancelled before it started.")
          : new RunnerError("run_refused", "The extension did not start the run.");
      if (stopAt !== null && Date.now() - stopAt > STOP_WAIT_MS) break; // stop wasn't heard: the result is lost
      if (stopAt === null && (signal?.aborted || Date.now() > deadline)) {
        ended = signal?.aborted ? "cancelled" : "timeout";
        onProgress(`stopping the run (${ended === "cancelled" ? "cancelled" : "time limit"})`);
        await send({ type: "stop" });
        stopAt = Date.now();
      }
      await sleep(POLL_MS);
    }
    let run = lost === null ? null : { status: "error", message: `The run was lost: ${lost}` };
    if (lost === null) await send({ type: "lastRun" });
    for (let i = 0; i < 20 && run === null; i++) {
      run = await panel.evaluate(() => globalThis.naceRunner.state.lastRun ?? null).catch(() => null);
      if (run === null) await sleep(250);
    }
    if (run === null) {
      const error = await panel.evaluate(() => globalThis.naceRunner.state.refused?.message ?? null).catch(() => null);
      if (error) run = { status: "error", message: error };
    }
    const page = agentPage(ctx, run?.report?.url);
    return await finish({ run, out, id, opts, created, started, page, ended });
  } catch (e) {
    if (signal?.aborted && !(e instanceof RunnerError))
      throw new RunnerError("cancelled", "The run was cancelled before it started.");
    throw e;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    if (ctx) await close();
    await network?.close();
    release();
    temp?.remove(); // after the browser has closed: Chromium writes to its profile until then
  }
}

/** Saves the run log and the end screen, and makes the result. */
async function finish({ run, out, id, opts, created, started, page, ended }) {
  const artifacts = [];
  const look = page && run?.status === "needs_user" ? await lookAt(page) : {};
  if (run?.record) {
    const file = path.join(out, "run.json");
    fs.writeFileSync(file, JSON.stringify(run, null, 1));
    artifacts.push({ kind: "run_log", path: file });
  }
  let shot = null;
  if (page) {
    const file = path.join(out, "final.png");
    shot = await page
      .screenshot({ path: file, timeout: 15000 })
      .then(() => file)
      .catch(() => null);
  }
  const reported = run?.report?.screenshot;
  if (!shot && typeof reported === "string" && reported.startsWith("data:image/")) {
    const [head, data] = reported.split(",", 2);
    const file = path.join(out, `final.${head.includes("png") ? "png" : "jpg"}`);
    fs.writeFileSync(file, Buffer.from(data, "base64"));
    shot = file;
  }
  if (shot) artifacts.push({ kind: "screenshot", step: null, path: shot });
  const result = resultOf(run, {
    id,
    task: opts.task,
    start_url: opts.url,
    profile: opts.profile,
    created_at: created,
    started_at: started,
    finished_at: new Date().toISOString(),
    final_url: page?.url() ?? null, // else resultOf takes the report's, unless the report is an error
    ended,
    page: look,
    artifacts,
  });
  const file = path.join(out, "result.json");
  result.artifacts.push({ kind: "result", path: file });
  fs.writeFileSync(file, JSON.stringify(result, null, 1));
  return result;
}

export function playwrightCli() {
  const require = createRequire(import.meta.url);
  return path.join(path.dirname(require.resolve("playwright/package.json")), "cli.js");
}
