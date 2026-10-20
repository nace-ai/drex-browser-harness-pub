import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
const dir = await mkdtemp(join(tmpdir(), "tabs-fallback-"));
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
test("planner tab references preserve owned context for unknown, closed and out-of-window targets", async () => {
  const known = new Map([
    [20, { id: 20, url: "http://owned.test/current", windowId: 7 }],
    [30, { id: 30, url: "http://owned.test/other", windowId: 7 }],
    [40, { id: 40, url: "http://unrelated.test", windowId: 8 }],
  ]);
  globalThis.chrome = {
    tabs: {
      get: async (id) => {
        if (!known.has(id)) throw Error("No tab");
        return known.get(id);
      },
    },
  };
  for (const requested of [1, 2, 4, 1.5, null, "nonsense"]) {
    const a = new Agent({ drex: {}, llm: {}, emit() {} });
    a.t0 = performance.now();
    a.windowId = 7;
    a.startTabs = [{ id: 10 }];
    a.agentTabId = 20;
    a.ownTab = true;
    a.activePlanTab = 0;
    a.tabBindings = new Map([
      [0, 20],
      [2, 99],
      [3, 30],
      [4, 40],
    ]);
    a.afterShot = "current evidence";
    let settled = 0;
    a.currentTab = async () => {
      assert.equal(a.agentTabId, 20);
      return { settle: async () => settled++ };
    };
    await a.prepare({ use_tab: requested, open_url: "" });
    assert.equal(a.ownTab, true);
    assert.equal(a.activePlanTab, 0);
    assert.equal(a.afterShot, "current evidence");
    assert.equal(settled, 1);
    assert.equal(a.tabBindings.has(1), false);
  }
});
test("valid numeric-string logical index switches to its existing owned binding", async () => {
  globalThis.chrome = { tabs: { get: async (id) => ({ id, url: "http://owned.test/other", windowId: 7 }) } };
  const a = new Agent({ drex: {}, llm: {}, emit() {} });
  a.t0 = performance.now();
  a.windowId = 7;
  a.startTabs = [{ id: 10 }, { id: 11 }];
  a.agentTabId = 20;
  a.ownTab = true;
  a.activePlanTab = 0;
  a.afterShot = "old";
  a.tabBindings = new Map([
    [0, 20],
    [1, 30],
  ]);
  a.currentTab = async () => {
    assert.equal(a.agentTabId, 30);
    return { settle: async () => {} };
  };
  await a.prepare({ use_tab: "1", open_url: "" });
  assert.equal(a.activePlanTab, 1);
  assert.equal(a.ownTab, true);
  assert.equal(a.afterShot, null);
});
test("the agent opens only http(s) tabs, so chrome.tabs cannot bypass the worker's page routing", async () => {
  const created = [];
  globalThis.chrome = {
    tabs: {
      create: async (opts) => (created.push(opts.url), { id: 50, ...opts }),
      update: async (_id, opts) => (created.push(opts.url), { id: 50, ...opts }),
      get: async () => ({ id: 50, url: "https://site.test/" }),
    },
  };
  const a = new Agent({ drex: {}, llm: {}, emit() {} });
  a.windowId = 7;
  a.group = async () => {};
  for (const url of ["file:///etc/hosts", "chrome://settings", "data:text/html,x", "javascript:1", "not a url"]) {
    await assert.rejects(a.openOwnTab(url), /Refusing to open/);
    await assert.rejects(a.openDetailTab(url), /Refusing to open/);
  }
  assert.deepEqual(created, []);
});
