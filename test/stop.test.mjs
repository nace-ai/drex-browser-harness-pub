import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Tab } from "../src/cdp.ts";

const dir = await mkdtemp(join(tmpdir(), "drex-stop-"));
await build({
  entryPoints: [join(process.env.CONTROLLER_SOURCE || resolve("src"), "agent.ts")],
  outfile: join(dir, "agent.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  packages: "external",
});
const { Agent } = await import(pathToFileURL(join(dir, "agent.mjs")));
await rm(dir, { recursive: true, force: true });

// what Chrome does with a command for a tab it unloaded, or a page that stopped answering: nothing, ever
const never = () => new Promise(() => {});
// fails the test instead of hanging it
const within = (p, ms) =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`still waiting after ${ms} ms`)), ms))]);
const noop = { addListener() {}, removeListener() {} };
const runChrome = (over = {}) => ({
  tabs: { onCreated: noop },
  debugger: { onDetach: noop },
  windows: { getLastFocused: async () => ({ id: 1 }) },
  ...over,
});
const step = { kind: "browse", goal: "Wait for the page", done_when: "", texts: [], rules: "", max_moves: 5 };
function agent() {
  const a = new Agent({ drex: {}, llm: {}, emit() {} });
  a.windowTabs = async () => [];
  a.fixedPlan = { steps: [step] };
  return a;
}
async function withChrome(fake, fn) {
  const previous = globalThis.chrome;
  globalThis.chrome = fake;
  try {
    await fn();
  } finally {
    globalThis.chrome = previous;
  }
}

test("Stop ends a run whose step is stuck waiting", () =>
  withChrome(runChrome(), async () => {
    const a = agent();
    a.prepare = async () => {};
    a.browse = never;
    const run = a.run("Wait");
    setTimeout(() => a.stop(), 20);
    const result = await within(run, 1000);
    assert.equal(result.status, "stopped");
    assert.equal(result.message, "Stopped by you.");
  }));

test("Stop ends a run whose step setup is stuck", () =>
  withChrome(runChrome(), async () => {
    const a = agent();
    a.prepare = never;
    a.browse = async () => assert.fail("the step must not start");
    const run = a.run("Wait");
    setTimeout(() => a.stop(), 20);
    assert.equal((await within(run, 1000)).status, "stopped");
  }));

test("Stop ends a run whose planning call is stuck", () =>
  withChrome(runChrome(), async () => {
    const a = agent();
    a.fixedPlan = null;
    a.planning = true;
    a.llm.plan = never;
    const run = a.run("Wait");
    setTimeout(() => a.stop(), 20);
    assert.equal((await within(run, 1000)).status, "stopped");
  }));

test("a run the user stopped ends as stopped even when its step then fails", () =>
  withChrome(runChrome(), async () => {
    const a = agent();
    a.prepare = async () => {};
    // stopping detaches the debugger, so a command still in flight fails with Chrome's own error
    a.browse = async () => {
      a.stop();
      throw new Error("Debugger is not attached to the tab with id: 5.");
    };
    const result = await within(a.run("Wait"), 1000);
    assert.equal(result.status, "stopped");
    assert.equal(result.message, "Stopped by you.");
  }));

test("Stop while a run that hit a limit writes its final answer ends the run as stopped, without that answer", () =>
  withChrome(runChrome(), async () => {
    const a = agent();
    a.prepare = async () => {};
    a.browse = async () => ({ fail: "Run Haiku physical-call limit reached", terminal: true });
    a.terminalAnswer = () => {
      setTimeout(() => a.stop(), 20);
      return never();
    };
    const result = await within(a.run("Wait"), 1000);
    assert.equal(result.status, "stopped");
    assert.equal(result.message, "Stopped by you.");
  }));

test("a DevTools command Chrome never answers rejects with the stop reason once the run stops", () =>
  withChrome({ debugger: { sendCommand: never } }, async () => {
    const tab = new Tab(5);
    const stop = new AbortController();
    tab.signal = stop.signal;
    const reason = new Error("Stopped by you.");
    const sent = tab.send("Runtime.evaluate", { expression: "1" });
    stop.abort(reason);
    await assert.rejects(within(sent, 500), (e) => e === reason);
  }));
