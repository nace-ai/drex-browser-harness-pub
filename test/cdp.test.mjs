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

// Google Sheets (2026-10-20): typed, a tab-separated table went into one cell, tabs and all; pasted, it fills the cells
test("Tab.type gives tab-separated text to the page as one paste, and types it when the page doesn't take it", async () => {
  const table = "Store\tPrice\nBest Buy\t$228.00\nTarget\t$399.99";
  const run = async (where, text = table) => {
    const tab = new Tab(7);
    const sent = [];
    tab.send = async (method, params = {}) => {
      sent.push([method, params]);
      if (method === "Runtime.evaluate")
        return { result: { value: params.expression.includes("ClipboardEvent") ? where : undefined } };
      return {};
    };
    const typed = await tab.type(text);
    return { sent, typed, inserted: sent.filter(([m]) => m === "Input.insertText").map(([, p]) => p.text) };
  };
  const pasted = await run("taken");
  const paste = pasted.sent.find(([m, p]) => m === "Runtime.evaluate" && p.expression.includes("ClipboardEvent"));
  assert.ok(paste, "a paste is offered first");
  assert.ok(paste[1].expression.includes(JSON.stringify(table)));
  assert.deepEqual([pasted.typed, pasted.inserted], [true, []]);

  const textarea = await run("other"); // a text area or document that didn't take the paste: typed, line by line
  assert.deepEqual(textarea.typed, true);
  assert.deepEqual(textarea.inserted, ["Store\tPrice", "Best Buy\t$228.00", "Target\t$399.99"]);

  // a one-line box (Sheets' menu search, which an unlabeled click had focused): its rows typed with Enter after each
  // ran the menu's "Import file"; the table is not typed there, and the move says so
  const box = await run("one-line");
  assert.deepEqual([box.typed, box.inserted], [false, []]);
  assert.equal(box.sent.filter(([m]) => m === "Input.dispatchKeyEvent").length, 0);
  assert.equal((await run("one-line", "Store\tPrice")).typed, true); // one row is not a table: typed as before

  const tab = new Tab(7); // text with no tabs is typed as always, no paste
  const methods = [];
  tab.send = async (method) => {
    methods.push(method);
    return { result: { value: undefined } };
  };
  await tab.type("Sony WH-1000XM5");
  assert.equal(methods.includes("Input.insertText"), false);
  assert.ok(methods.includes("Input.dispatchKeyEvent"));
  assert.equal(methods.filter((m) => m === "Runtime.evaluate").length, 1); // only the input notification
});
