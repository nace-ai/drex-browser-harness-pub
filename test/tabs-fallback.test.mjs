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
test("an open_url with no scheme (a path from the site map) opens on the page the agent's tab shows; non-web schemes are still refused", async () => {
  const opened = [];
  globalThis.chrome = {
    tabs: {
      create: async (opts) => (opts.url !== "about:blank" && opened.push(opts.url), { id: 51, ...opts }),
      update: async (_id, opts) => (opened.push(opts.url), { id: 50, ...opts }),
      get: async () => ({ id: 50, url: "http://shop.test/admin/dashboard/" }),
    },
  };
  const a = new Agent({ drex: {}, llm: {}, emit() {} });
  a.t0 = performance.now();
  a.windowId = 7;
  a.group = async () => {};
  a.agentTabId = 50;
  a.ownTab = true;
  a.currentTab = async () => ({ settle: async () => {} });
  // another tab of the user's, on a site the agent's page is not on
  a.task = "Open the sales orders";
  a.startTabs = [{ id: 10, url: "https://other.test/home" }];
  // a plan step's path, opened as prepare() opens it (the step died here as a malformed URL)
  await a.prepare({ use_tab: -1, open_url: "/admin/sales/order/" });
  // an absolute URL is unchanged
  await a.openOwnTab("https://other.test/x");
  // a detail tab's address resolves the same way
  await a.openDetailTab("/admin/customer/");
  assert.deepEqual(opened, [
    "http://shop.test/admin/sales/order/",
    "https://other.test/x",
    "http://shop.test/admin/customer/",
  ]);
  // a page to resolve on does not make a non-web scheme, prose, or another site's scheme-relative address an address
  for (const url of [
    "file:///etc/hosts",
    "chrome://settings",
    "data:text/html,x",
    "javascript:alert(1)",
    "not a url",
    "//evil.test/x?y=1",
    "/\\evil.test/x",
    "\\\\evil.test\\x",
    "//other.test/x", // refused on the page the path was resolved on, so not retried on the user's other tab
  ]) {
    await assert.rejects(a.openOwnTab(url), /Refusing to open/);
    await assert.rejects(a.openDetailTab(url), /Refusing to open/);
  }
  // an open_url that is not text (the LLM's JSON) is refused as malformed, as it always was
  await assert.rejects(a.openOwnTab(5), /Refusing to open a malformed URL/);
  await assert.rejects(a.openDetailTab(5), /Refusing to open a malformed URL/);
  assert.equal(opened.length, 3);
});
test("with no page to resolve on, a path resolves on the first address in the task, else on the user's first tab; with neither it is refused", async () => {
  const opened = [];
  globalThis.chrome = {
    tabs: {
      create: async (opts) => (opts.url !== "about:blank" && opened.push(opts.url), { id: 60, ...opts }),
      update: async (_id, opts) => (opened.push(opts.url), { id: 60, ...opts }),
      get: async (id) => {
        if (id === 50) return { id: 50, url: "about:blank" }; // a tab the agent opened, not yet on its page
        throw Error("No tab");
      },
    },
  };
  const agentWith = (task, startTabs) => {
    const a = new Agent({ drex: {}, llm: {}, emit() {} });
    a.t0 = performance.now();
    a.windowId = 7;
    a.group = async () => {};
    a.task = task;
    a.startTabs = startTabs;
    return a;
  };
  const tabs = [{ id: 10, url: "http://start.test/home" }];
  const named = "Go to http://shop.test/admin and open the orders";
  // no agent tab yet: the address in the task, or else the user's first tab
  await agentWith(named, tabs).openOwnTab("/admin/sales/order/");
  await agentWith("Open the orders", tabs).openOwnTab("/admin/sales/order/");
  // an agent tab that shows no web page yet (about:blank) is no page to resolve on either
  const blank = agentWith(named, tabs);
  blank.agentTabId = 50;
  blank.ownTab = true;
  await blank.openOwnTab("/admin/sales/order/");
  assert.deepEqual(opened, [
    "http://shop.test/admin/sales/order/",
    "http://start.test/admin/sales/order/",
    "http://shop.test/admin/sales/order/",
  ]);
  // neither: a path is no address, so it is refused as before
  await assert.rejects(agentWith("Open the orders", []).openOwnTab("/admin/sales/order/"), /malformed URL/);
  assert.equal(opened.length, 3);
});
