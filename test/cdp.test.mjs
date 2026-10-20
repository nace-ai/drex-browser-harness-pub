import assert from "node:assert/strict";
import { test } from "node:test";
import { keyOf, networkBusy, Tab } from "../src/cdp.ts";

test("networkBusy ignores background requests that were open before the move (Gmail's channel)", () => {
  const input = 10_000; // the move's input event
  const inflight = new Map([["channel", 2_000]]); // opened long before the move, never ends
  assert.equal(networkBusy(inflight, input, input + 300), false);
});

test("networkBusy waits for a request the move started, but only while it is young", () => {
  const input = 10_000;
  const inflight = new Map([["save", input + 40]]);
  assert.equal(networkBusy(inflight, input, input + 400), true);
  assert.equal(networkBusy(inflight, input, input + 1_500), false); // a long-poll reopened by the move stops counting
});

test("keyOf gives US key codes, with Shift for shifted characters", () => {
  assert.deepEqual(keyOf("a"), { code: "KeyA", vk: 65, shift: false });
  assert.deepEqual(keyOf("A"), { code: "KeyA", vk: 65, shift: true });
  assert.deepEqual(keyOf("@"), { code: "Digit2", vk: 50, shift: true });
  assert.deepEqual(keyOf("."), { code: "Period", vk: 190, shift: false });
  assert.equal(keyOf("ж"), null);
});

test("Tab.navigate loads the page over CDP and waits for the new document", async () => {
  const tab = new Tab(7);
  let href = "http://owned.test/orders/1";
  const sent = [];
  tab.send = async (method, params = {}) => {
    sent.push(method);
    if (method === "Page.navigate") {
      setTimeout(() => {
        href = params.url;
      }, 50); // the new document arrives a moment later
      return { frameId: "f", loaderId: "l" };
    }
    if (method === "Runtime.evaluate") {
      const value = params.expression === "location.href" ? href : ["complete", 10_000];
      return { result: { value } };
    }
    throw new Error(`unexpected ${method}`);
  };
  await tab.navigate("http://owned.test/orders");
  assert.equal(href, "http://owned.test/orders");
  assert.equal(sent.filter((m) => m === "Page.navigate").length, 1);
  assert.ok(sent.lastIndexOf("Runtime.evaluate") > sent.indexOf("Page.navigate"));

  tab.send = async (method) =>
    method === "Page.navigate" ? { errorText: "net::ERR_NAME_NOT_RESOLVED" } : { result: { value: href } };
  await assert.rejects(tab.navigate("http://owned.test/missing"), /ERR_NAME_NOT_RESOLVED/);
  tab.send = async () => assert.fail("no CDP call for a refused address");
  await assert.rejects(tab.navigate("javascript:alert(1)"), /Refusing/);
});

test("Tab.gesture rejects a keychord whose modifier is an array, before any Input event", async () => {
  const tab = new Tab(7);
  const sent = [];
  tab.send = async (method) => {
    sent.push(method);
    return {};
  };
  await assert.rejects(
    tab.gesture({ kind: "keychord", key: "Tab", modifiers: [["Alt"]] }),
    /Unsupported page key or modifier/,
  );
  assert.deepEqual(sent, []);
});
