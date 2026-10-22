import assert from "node:assert/strict";
import { test } from "node:test";
import vm from "node:vm";
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

// confirmedChanges: the tab's own record of the site requests that may change something (POST, PUT, PATCH, DELETE)
// and how the site answered them, fed the Network events Chrome sends the tab
const SITE = "http://shop.test";
const feed = (tab, method, params) => tab.onEvent({ tabId: tab.id }, method, params);
const sent = (tab, requestId, method, url, { type = "XHR", documentURL = `${SITE}/admin/rule/edit`, postData } = {}) =>
  feed(tab, "Network.requestWillBeSent", {
    requestId,
    documentURL,
    type,
    request: { method, url, ...(postData === undefined ? {} : { postData }) },
  });
const answered = (tab, requestId, status, url = "") =>
  feed(tab, "Network.responseReceived", { requestId, type: "XHR", response: { status, url } });
const later = () => new Promise((r) => setTimeout(r, 5));

// test_mutation_record_confirms_2xx_and_3xx
test("the mutation record confirms a site's 2xx and 3xx answers to a change made since the move", async () => {
  const tab = new Tab(7);
  sent(tab, "old", "POST", `${SITE}/wishlist/add`); // before the move: not its doing
  answered(tab, "old", 200);
  await later();
  const since = performance.now();
  sent(tab, "1", "POST", `${SITE}/newsletter/subscriber/new`, { type: "Document" });
  answered(tab, "1", 200);
  sent(tab, "2", "PUT", `${SITE}/rest/V1/carts/mine?form_key=x`, { type: "Fetch" });
  answered(tab, "2", 204);
  sent(tab, "3", "GET", `${SITE}/catalog/product/view`); // a GET changes nothing
  answered(tab, "3", 200);
  sent(tab, "4", "DELETE", `${SITE}/api/items/4`); // not answered yet: nothing to report
  assert.deepEqual(tab.mutationsSince(since), {
    confirmed: ["POST /newsletter/subscriber/new 200", "PUT /rest/V1/carts/mine 204"],
    rejected: [],
    strong: true,
  });
});

// test_mutation_record_rejects_4xx
test("the mutation record rejects a change the site answered with 4xx or 5xx (Reddit 720's HTTP 400 upvote)", async () => {
  const tab = new Tab(7);
  const since = performance.now();
  sent(tab, "1", "POST", `${SITE}/sv/44650.json`);
  answered(tab, "1", 400);
  sent(tab, "2", "PATCH", `${SITE}/api/profile`);
  answered(tab, "2", 500);
  assert.deepEqual(tab.mutationsSince(since), {
    confirmed: [],
    rejected: ["POST /sv/44650.json 400", "PATCH /api/profile 500"],
  });
});

// test_mutation_record_ignores_telemetry
test("the mutation record leaves out telemetry: collect, analytics and track paths, pings and beacons", async () => {
  const tab = new Tab(7);
  const since = performance.now();
  sent(tab, "1", "POST", `${SITE}/collect?v=2`);
  answered(tab, "1", 204);
  sent(tab, "2", "POST", `${SITE}/analytics/track`);
  answered(tab, "2", 200);
  sent(tab, "3", "POST", `${SITE}/customer/section/save`, { type: "Ping" }); // navigator.sendBeacon
  answered(tab, "3", 200);
  sent(tab, "4", "POST", `${SITE}/api/log`);
  answered(tab, "4", 500);
  sent(tab, "5", "POST", `${SITE}/admin/rule/save`, { type: "Document" });
  answered(tab, "5", 200);
  assert.deepEqual(tab.mutationsSince(since), {
    confirmed: ["POST /admin/rule/save 200"],
    rejected: [],
    strong: true,
  });
});

// test_mutation_record_counts_redirect_once
test("a form post answered 302 and then the page it redirects to counts once, as the post's 302", async () => {
  const tab = new Tab(7);
  const since = performance.now();
  sent(tab, "9", "POST", `${SITE}/admin/sales_rule/promo_quote/save/`, { type: "Document" });
  // Chrome reports the redirect as the same request sent again, as a GET, with the POST's answer beside it
  feed(tab, "Network.requestWillBeSent", {
    requestId: "9",
    documentURL: `${SITE}/admin/sales_rule/promo_quote/`,
    type: "Document",
    request: { method: "GET", url: `${SITE}/admin/sales_rule/promo_quote/` },
    redirectResponse: { status: 302, url: `${SITE}/admin/sales_rule/promo_quote/save/` },
  });
  answered(tab, "9", 200, `${SITE}/admin/sales_rule/promo_quote/`); // the GET's answer: not a change
  feed(tab, "Network.loadingFinished", { requestId: "9" });
  assert.deepEqual(tab.mutationsSince(since), {
    confirmed: ["POST /admin/sales_rule/promo_quote/save/ 302"],
    rejected: [],
    strong: true,
  });
  // a 307 keeps the method: the request continues, and the answer at its end is the post's
  await later();
  const next = performance.now();
  sent(tab, "10", "POST", `${SITE}/cart/update`);
  feed(tab, "Network.requestWillBeSent", {
    requestId: "10",
    documentURL: `${SITE}/admin/rule/edit`,
    type: "XHR",
    request: { method: "POST", url: `${SITE}/cart/update/v2` },
    redirectResponse: { status: 307, url: `${SITE}/cart/update` },
  });
  answered(tab, "10", 500);
  assert.deepEqual(tab.mutationsSince(next), { confirmed: [], rejected: ["POST /cart/update 500"] });
});

// test_mutation_record_strong (ruling 15)
test("a confirmed form post that navigates (Document) or a PUT, PATCH or DELETE is strong; an XHR or Fetch POST is not", async () => {
  const tab = new Tab(7);
  const since = performance.now();
  sent(tab, "1", "POST", `${SITE}/api/search`); // XHR
  answered(tab, "1", 200);
  sent(tab, "2", "POST", `${SITE}/api/filters`, { type: "Fetch" });
  answered(tab, "2", 200);
  sent(tab, "3", "POST", `${SITE}/account/save`, { type: "Document" }); // refused: not a change
  answered(tab, "3", 400);
  assert.deepEqual(tab.mutationsSince(since), {
    confirmed: ["POST /api/search 200", "POST /api/filters 200"],
    rejected: ["POST /account/save 400"],
  });
  for (const [method, type] of [
    ["DELETE", "XHR"],
    ["PATCH", "Fetch"],
    ["POST", "Document"],
  ]) {
    await later();
    const next = performance.now();
    sent(tab, method + type, method, `${SITE}/api/items/4`, { type });
    answered(tab, method + type, 200);
    assert.equal(tab.mutationsSince(next).strong, true, `${method} ${type}`);
  }
});

// test_note_mutation_contained
test("a throw in the mutation record neither escapes the debugger listener nor skips the diagnostics", () => {
  const tab = new Tab(7);
  tab.diagnostics = true;
  tab.noteMutation = () => {
    throw new TypeError("an event of an unexpected shape");
  };
  assert.doesNotThrow(() =>
    feed(tab, "Network.responseReceived", { requestId: "1", type: "XHR", response: { status: 500, url: `${SITE}/x` } }),
  );
  assert.deepEqual(tab.problems, [{ kind: "HTTP 500", text: `${SITE}/x` }]);
});

// test_mutation_record_site_origin_only
test("the mutation record keeps the site's own requests only, not another origin's (a widget, a frame)", async () => {
  const tab = new Tab(7);
  feed(tab, "Page.frameNavigated", { frame: { id: "main", url: `${SITE}/checkout`, loaderId: "l" } });
  const since = performance.now();
  sent(tab, "1", "POST", "https://api.payments.test/v1/tokens"); // the site's page posts to another origin
  answered(tab, "1", 200);
  // a third-party frame posting to its own origin
  sent(tab, "2", "POST", "https://widget.test/reload", { documentURL: "https://widget.test/frame" });
  answered(tab, "2", 200);
  sent(tab, "3", "POST", `${SITE}/checkout/cart/add`);
  answered(tab, "3", 200);
  assert.deepEqual(tab.mutationsSince(since), { confirmed: ["POST /checkout/cart/add 200"], rejected: [] });
});

// test_mutation_record_graphql_query_not_counted
test("a GraphQL post counts only when it is a mutation: a query reads, and a body Chrome left out says nothing", () => {
  const tab = new Tab(7);
  const since = performance.now();
  const graphql = `${SITE}/api/graphql`;
  sent(tab, "1", "POST", graphql, { postData: JSON.stringify({ query: "query getIssue { issue { title } }" }) });
  answered(tab, "1", 200);
  sent(tab, "2", "POST", graphql, {
    postData: JSON.stringify({ query: "\n  mutation createNote { createNote { id } }" }),
  });
  answered(tab, "2", 200);
  sent(tab, "3", "POST", graphql); // no postData (too large, or not sent with the event)
  answered(tab, "3", 200);
  sent(tab, "4", "POST", graphql, { postData: JSON.stringify([{ query: "mutation awardEmoji { x }" }]) }); // batched
  answered(tab, "4", 400);
  sent(tab, "5", "POST", graphql, { postData: "not json" });
  answered(tab, "5", 200);
  // the body as Chrome also sends it, base64 entries (postData is deprecated in the protocol)
  const bytes = Buffer.from(JSON.stringify({ operationName: "x", query: "mutation updateIssue { x }" })).toString(
    "base64",
  );
  feed(tab, "Network.requestWillBeSent", {
    requestId: "6",
    documentURL: `${SITE}/admin/rule/edit`,
    type: "Fetch",
    request: { method: "POST", url: graphql, postDataEntries: [{ bytes }] },
  });
  answered(tab, "6", 201);
  assert.deepEqual(tab.mutationsSince(since), {
    confirmed: ["POST /api/graphql 200", "POST /api/graphql 201"],
    rejected: ["POST /api/graphql 400"],
  });
});

test("test_key_arrowdown_dispatches: Tab.key sends a keyDown and a keyUp for ArrowDown", async () => {
  const tab = new Tab(7);
  const events = [];
  tab.send = async (method, params) => {
    if (method === "Input.dispatchKeyEvent") events.push(params);
    return {};
  };
  await tab.key("ArrowDown");
  assert.equal(events.length, 2);
  for (const e of events) {
    assert.equal(e.key, "ArrowDown");
    assert.equal(e.windowsVirtualKeyCode, 40);
  }
  assert.equal(events[0].type, "rawKeyDown");
  assert.equal(events[1].type, "keyUp");
});

test("test_keychord_ctrl_c_sends_copy_command: Control+c carries the copy edit command", async () => {
  const tab = new Tab(7);
  const events = [];
  tab.send = async (method, params) => {
    if (method === "Input.dispatchKeyEvent") events.push(params);
    return {};
  };
  await tab.gesture({ kind: "keychord", key: "c", modifiers: ["Control"] });
  const chord = events.find((e) => e.key === "c" && e.type !== "keyUp");
  assert.deepEqual(chord.commands, ["copy"]);
  for (const [key, command] of [
    ["v", "paste"],
    ["x", "cut"],
  ]) {
    events.length = 0;
    await tab.gesture({ kind: "keychord", key, modifiers: ["Meta"] });
    assert.deepEqual(events.find((e) => e.key === key && e.type !== "keyUp").commands, [command]);
  }
});

test("test_keychord_plain_c_rejected: c, v and x need Control or Meta", async () => {
  const tab = new Tab(7);
  const sent = [];
  tab.send = async (method) => {
    sent.push(method);
    return {};
  };
  for (const key of ["c", "v", "x"])
    await assert.rejects(
      tab.gesture({ kind: "keychord", key, modifiers: [] }),
      /Only page editing\/navigation key combinations are allowed/,
    );
  assert.deepEqual(sent, []);
});

// Tab.dragTo on a stub page: boxes holds each node's BOX_FN box (left, top, width, height in CSS px; null: no box) in a
// 1280x800 viewport; moves says whether the page moves the dragged element once the mouse is released.
const dragRun = async (boxes, moves, [from, to] = [2, 3]) => {
  const tab = new Tab(7);
  const mouse = [];
  let released = false;
  tab.send = async (method, params = {}) => {
    if (method === "DOM.resolveNode") return { object: { objectId: `node${params.backendNodeId}` } };
    if (method === "Runtime.callFunctionOn") {
      const node = Number(params.objectId.slice(4));
      // BOX_FN, which Tab.centre reads: left, top, width, height, then the flags
      if (params.functionDeclaration.includes("covered")) {
        if (!boxes[node]) return { result: { value: null } };
        const [x, y, w, h] = boxes[node];
        return { result: { value: [x, y, w, h, false, "", false, false, false, false, false, node === 2] } };
      }
      // where the dragged element sits, before and after: it moves only if the page moved it
      return { result: { value: [released && moves ? 210 : 10, 20, 30, 40, 1] } };
    }
    if (method === "Runtime.evaluate") return { result: { value: [1280, 800] } }; // the viewport
    if (method === "Input.dispatchMouseEvent") {
      mouse.push(params);
      if (params.type === "mouseReleased") released = true;
      return {};
    }
    throw new Error(`unexpected ${method}`);
  };
  return { changed: await tab.dragTo(from, to), mouse };
};

test("test_dragto_sends_press_moves_release: press on one element's centre, moves with the button held, release on the other's", async () => {
  // a source, a target to its right, one below it, a target 4 px wide; a target whose centre is below the fold (its
  // top 100 px on screen) and a source cut by the left edge (its right 20 px on screen)
  const boxes = {
    2: [10, 20, 30, 40],
    3: [200, 100, 50, 50],
    4: [20, 300, 10, 10],
    5: [300, 30, 4, 4],
    6: [200, 700, 50, 300],
    7: [-20, 20, 40, 40],
  };
  const run = (moves, pair) => dragRun(boxes, moves, pair);
  const release = (mouse) => {
    const last = mouse.at(-1);
    assert.equal(last.type, "mouseReleased");
    return [last.x, last.y];
  };
  const { changed, mouse } = await run(true);
  const press = mouse.findIndex((e) => e.type === "mousePressed");
  assert.ok(press >= 0, "a press");
  // before the press, the mouse only goes to the source (no button held)
  assert.ok(mouse.slice(0, press).every((e) => e.type === "mouseMoved" && !e.buttons));
  const seq = mouse.slice(press);
  assert.deepEqual([seq[0].x, seq[0].y], [25, 40]); // the source's centre
  const held = seq.slice(1, -1);
  assert.ok(held.length >= 8, `${held.length} moves`);
  assert.ok(held.every((e) => e.type === "mouseMoved" && e.buttons === 1));
  // the target's centre is (225, 125); the drag goes mostly right, so it ends 3 px past the centre on x alone (a
  // sortable list puts the item before the target only once the pointer crosses the target's middle)
  assert.deepEqual([held.at(-1).x, held.at(-1).y], [228, 125]);
  assert.deepEqual(release(seq), [228, 125]);
  assert.equal(seq.filter((e) => e.type === "mouseReleased").length, 1);
  assert.equal(changed, true);
  // the same drag on a page that moved nothing
  assert.equal((await run(false)).changed, false);
  // the other way (mostly left): past the centre (25, 40) to the left
  const back = (await run(true, [3, 2])).mouse;
  assert.deepEqual([back[0].x, back[0].y], [225, 125]);
  assert.deepEqual(release(back), [22, 40]);
  // straight down onto the target below (centre (25, 305)): past it on y alone
  assert.deepEqual(release((await run(true, [2, 4])).mouse), [25, 308]);
  // a target 4 px wide (300..304, centre 302): the release stays inside it
  const [x, y] = release((await run(true, [2, 5])).mouse);
  assert.ok(x > 302 && x < 304 && y === 32, `${x}, ${y}`);
  // partly on screen, each is dragged or dropped at the middle of its part on screen, as Drex is shown it: the target's
  // visible part is 700..800 (middle 750; its full centre, 850, is off screen), the release 3 px past it going down
  const tall = await run(true, [2, 6]);
  assert.equal(tall.changed, true);
  assert.deepEqual(release(tall.mouse), [225, 753]);
  const cut = await run(true, [7, 3]);
  const pressed = cut.mouse.find((e) => e.type === "mousePressed");
  assert.deepEqual([pressed.x, pressed.y], [10, 40]); // 0..20 on screen, not the box's centre at x 0
});

test("test_dragto_not_on_screen_sends_nothing: a source or target with no part on screen is refused with null, not false", async () => {
  // below the fold, right of the screen, a 2 px sliver at the bottom edge, and no box at all (BOX_FN's null)
  const boxes = {
    2: [10, 20, 30, 40],
    3: [200, 900, 50, 50],
    4: [1300, 30, 40, 40],
    5: [200, 798, 50, 50],
    6: null,
    7: [200, 100, 50, 50],
  };
  for (const pair of [
    [2, 3],
    [2, 4],
    [2, 5],
    [2, 6],
    [3, 2],
    [6, 2],
  ]) {
    const { changed, mouse } = await dragRun(boxes, true, pair);
    assert.equal(changed, null, `${pair}`);
    assert.deepEqual(mouse, [], `${pair}: nothing sent`);
  }
  // a drag that was sent and that the page ignored is false, which is not the same
  const ignored = await dragRun(boxes, false, [2, 7]);
  assert.equal(ignored.changed, false);
  assert.ok(ignored.mouse.some((e) => e.type === "mouseReleased"));
});

// MiniWoB book-flight (round 6): "Emmonak, AK" typed into From, the live region said "1 result is available", nothing
// picked it, and the next city landed in the same field. Tab.pickSuggestion is fed suggestions() readings here; the
// field's state (value, aria-activedescendant, focus) is read after each action, in order.
const suggestionTab = (found, states = [{ value: "", active: "", focused: true }]) => {
  const tab = new Tab(7);
  const did = [];
  let reads = 0;
  tab.suggestions = async (node, since) => {
    did.push(["suggestions", node, since]);
    return typeof found === "function" ? found() : found;
  };
  tab.click = async (x, y) => void did.push(["click", x, y]);
  tab.key = async (name) => void did.push(["key", name]);
  tab.on = async () => states[Math.min(reads++, states.length - 1)];
  return { tab, did, acts: () => did.filter(([what]) => what !== "suggestions") };
};
const state = (value, active = "") => ({ value, active, focused: true });

test("test_pick_exact_match_clicks_item: of two suggestions the one equal to the typed text is clicked at its centre", async () => {
  const items = [
    { x: 60, y: 110, text: "Boston, MA (BOS)" },
    { x: 60, y: 130, text: "boston,  MA" },
  ];
  const { tab, did, acts } = suggestionTab({ items, announced: true }, [state("Boston, MA")]);
  assert.deepEqual(await tab.pickSuggestion(4, "Boston, MA", 1000), { ok: true, picked: "boston,  MA" });
  assert.deepEqual(did[0], ["suggestions", 4, 1000]);
  assert.deepEqual(acts(), [["click", 60, 130]]);
  // none equal: the first that starts with the typed text, else the first that contains it as a word, else the first
  // that contains it at all (book-flight seed 3: "SHV" is in "Nashville, TN (BNA)", listed before "Shreveport, LA (SHV)")
  const kotlik = { x: 1, y: 1, text: "Kotlik, AK (KOT)" };
  for (const [item, typed, other = kotlik] of [
    [{ x: 2, y: 2, text: "Emmonak, AK (EMK)" }, "emmonak,  ak"],
    [{ x: 3, y: 3, text: "Near Emmonak, AK" }, "Emmonak, AK"],
    [{ x: 4, y: 4, text: "Shreveport, LA (SHV)" }, "SHV", { x: 5, y: 5, text: "Nashville, TN (BNA)" }],
    [{ x: 6, y: 6, text: "Nashville, TN (BNA)" }, "shv"],
  ]) {
    const t = suggestionTab({ items: [other, item], announced: false }, [state(item.text)]);
    assert.deepEqual(await t.tab.pickSuggestion(4, typed, 1000), { ok: true, picked: item.text });
    assert.deepEqual(t.acts(), [["click", item.x, item.y]]);
  }
});

test("test_pick_single_item_without_match: the only suggestion is taken when none matches, then the field is checked", async () => {
  const only = { items: [{ x: 70, y: 140, text: "Emmonak, AK (EMK)" }], announced: true };
  const { tab, acts } = suggestionTab(only, [state("Emmonak, AK (EMK)")]);
  assert.deepEqual(await tab.pickSuggestion(4, "Emonak", 1000), { ok: true, picked: "Emmonak, AK (EMK)" });
  assert.deepEqual(acts(), [["click", 70, 140]]);
  // the field holds neither the typed text nor the item after the click: not committed
  const missed = suggestionTab(only, [state("Kotlik, AK (KOT)")]);
  assert.deepEqual(await missed.tab.pickSuggestion(4, "Emonak", 1000), { ok: false, picked: "Emmonak, AK (EMK)" });
  // the notice said one result, the list shows more rows: its first item is taken
  const rows = [
    { x: 70, y: 140, text: "Emmonak, AK (EMK)" },
    { x: 70, y: 160, text: "Search all airports" },
  ];
  const said = suggestionTab({ items: rows, announced: true, one: true }, [state("Emmonak, AK (EMK)")]);
  assert.deepEqual(await said.tab.pickSuggestion(4, "Emonak", 1000), { ok: true, picked: "Emmonak, AK (EMK)" });
  assert.deepEqual(said.acts(), [["click", 70, 140]]);
});

test("test_pick_none_when_many_and_no_match: several suggestions and none matching: nothing is clicked", async () => {
  const items = [
    { x: 1, y: 1, text: "Kotlik, AK (KOT)" },
    { x: 2, y: 2, text: "Nome, AK (OME)" },
  ];
  const { tab, acts } = suggestionTab({ items, announced: true }, [state("Emmonak, AK")]);
  // a list appeared (picked is set, so the agent logs it) but nothing in it is the typed text
  assert.deepEqual(await tab.pickSuggestion(4, "Emmonak, AK", 1000), { ok: false, picked: "" });
  assert.deepEqual(acts(), []);
  // nothing appeared within the wait: no picked at all (the agent logs nothing), no click, no key
  let polls = 0;
  const quiet = suggestionTab(() => (polls++, { items: [], announced: false }));
  const t0 = performance.now();
  assert.deepEqual(await quiet.tab.pickSuggestion(4, "Alice", 1000, 400), { ok: false });
  assert.ok(polls >= 2 && performance.now() - t0 < 1200, `${polls} polls`);
  assert.deepEqual(quiet.acts(), []);
  // a notice of no results ends the wait at once: nothing will come to pick
  polls = 0;
  const empty = suggestionTab(() => (polls++, { items: [], announced: false, none: true }));
  const t1 = performance.now();
  assert.deepEqual(await empty.tab.pickSuggestion(4, "Emonak", 1000), { ok: false, noResults: true });
  assert.ok(polls === 1 && performance.now() - t1 < 100, `${polls} polls`);
  assert.deepEqual(empty.acts(), []);
  // no wait at all (a combobox whose list never came): one look
  polls = 0;
  assert.deepEqual(await quiet.tab.pickSuggestion(4, "Alice", 1000, 0), { ok: false });
  assert.equal(polls, 1);
});

test("test_pick_announced_without_list_uses_arrow_enter: a results notice with no list found: ArrowDown, then Enter", async () => {
  // jQuery UI's arrow puts the highlighted suggestion in the field; Enter commits it
  const { tab, acts } = suggestionTab({ items: [], announced: true }, [
    state("Emmonak, AK"),
    state("Emmonak, AK (EMK)"),
    state("Emmonak, AK (EMK)"),
  ]);
  assert.deepEqual(await tab.pickSuggestion(4, "Emmonak, AK", 1000), { ok: true, picked: "Emmonak, AK (EMK)" });
  assert.deepEqual(acts(), [
    ["key", "ArrowDown"],
    ["key", "Enter"],
  ]);
  // an ARIA combobox marks the highlighted option on the field instead
  const aria = suggestionTab({ items: [], announced: true }, [
    state("Emmonak"),
    state("Emmonak", "opt-1"),
    state("Emmonak, AK (EMK)"),
  ]);
  assert.deepEqual(await aria.tab.pickSuggestion(4, "Emmonak", 1000), { ok: true, picked: "Emmonak, AK (EMK)" });
  assert.deepEqual(aria.acts().length, 2);
  // the arrow changed nothing (no list answers it): no Enter, which would submit the field's form
  const still = suggestionTab({ items: [], announced: true }, [state("Emmonak, AK")]);
  assert.deepEqual(await still.tab.pickSuggestion(4, "Emmonak, AK", 1000), { ok: false, picked: "" });
  assert.deepEqual(still.acts(), [["key", "ArrowDown"]]);
  // the field no longer has the focus: the keys would go to whatever has it, so none is pressed
  const away = { value: "Emmonak, AK", active: "", focused: false };
  const elsewhere = suggestionTab({ items: [], announced: true }, [away, away, away]);
  assert.deepEqual(await elsewhere.tab.pickSuggestion(4, "Emmonak, AK", 1000), { ok: false, picked: "" });
  assert.deepEqual(elsewhere.acts(), []);
});

// The page script itself, in a small fake DOM: lists by the spec's kinds, each counted only once it shows after the
// mark taken before typing; a live region's new "N results" notice
test("test_suggestions_only_lists_shown_since_typing: a list on screen before the typing is no suggestion", async () => {
  const below = (e) => e.kids.flatMap((k) => [k, ...below(k)]);
  const node = ({ sel = [], box = [0, 0, 100, 20], text = "", attrs = {}, kids = [] }) => {
    const e = {
      sel: new Set(sel),
      box,
      text,
      kids,
      shown: true,
      getAttribute: (n) => attrs[n] ?? null,
      getBoundingClientRect: () => {
        const [left, top, width, height] = e.shown ? e.box : [0, 0, 0, 0];
        return { left, top, width, height };
      },
      querySelectorAll: (s) => below(e).filter((k) => s.split(",").some((part) => k.sel.has(part.trim()))),
      contains: (o) => o === e || below(e).includes(o),
      get innerText() {
        return e.shown ? e.text : "";
      },
      get textContent() {
        return e.text;
      },
    };
    return e;
  };
  const field = node({ attrs: { "aria-controls": "named" } });
  const recent = node({
    sel: ["[role=listbox]"],
    box: [0, 200, 200, 20],
    kids: [node({ sel: ["[role=option]"], box: [0, 200, 200, 20], text: "Recent: Boston, MA" })],
  });
  const menu = node({
    sel: ["ul.ui-autocomplete"],
    box: [0, 30, 200, 40],
    kids: [
      node({ sel: ["li"], box: [0, 30, 200, 20], text: "Emmonak, AK (EMK)" }),
      node({ sel: ["li"], box: [0, 900, 200, 20], text: "Below the screen, AK" }),
    ],
  });
  const named = node({
    box: [300, 30, 200, 20],
    kids: [node({ sel: ["[role=option]"], box: [300, 30, 200, 20], text: "Emmonak  (named list)" })],
  });
  const status = node({ sel: ["[role=status]"], box: [0, 0, 1, 1] });
  const all = [field, recent, menu, named, status].flatMap((e) => [e, ...below(e)]);
  const document = {
    querySelectorAll: (s) => all.filter((e) => s.split(",").some((part) => e.sel.has(part.trim()))),
    getElementById: (id) => (id === "named" ? named : null),
    elementFromPoint: (x, y) =>
      all.findLast((e) => {
        const r = e.getBoundingClientRect();
        return !e.kids.length && r.width && x >= r.left && x < r.left + r.width && y >= r.top && y < r.top + r.height;
      }) ?? null,
  };
  const ctx = vm.createContext({
    document,
    innerWidth: 1280,
    innerHeight: 800,
    getComputedStyle: (e) => ({ visibility: "visible", display: e.shown ? "block" : "none", opacity: "1" }),
  });
  vm.runInContext("var window = globalThis;", ctx);
  const tab = new Tab(7);
  tab.send = async (method, params) => {
    if (method === "DOM.resolveNode") return { object: { objectId: "field" } };
    assert.equal(method, "Runtime.callFunctionOn");
    const value = vm.runInContext(`(${params.functionDeclaration})`, ctx).call(field);
    return { result: { value: JSON.parse(JSON.stringify(value)) } };
  };
  menu.shown = named.shown = false; // before typing: only the recent-searches list shows
  const since = await tab.markSuggestions(3);
  assert.equal(typeof since, "number");
  // the typing opens the autocomplete list and the field's own list, and the live region announces the result
  menu.shown = named.shown = true;
  status.text = "1 result is available, use up and down arrow keys to navigate.";
  const found = await tab.suggestions(3, since);
  assert.deepEqual(found, {
    items: [
      { x: 400, y: 40, text: "Emmonak (named list)" },
      { x: 100, y: 40, text: "Emmonak, AK (EMK)" },
    ],
    announced: true,
    one: true,
    none: false,
  }); // the recent list was there before; the item below the screen can't be clicked
  status.text = "3 results are available";
  assert.deepEqual(await tab.suggestions(3, since).then(({ announced, one, none }) => [announced, one, none]), [
    true,
    false,
    false,
  ]);
  // a notice of no results (jQuery UI's own words, and others) announces nothing to pick
  for (const text of ["No search results.", "No results available", "0 results"]) {
    status.text = text;
    const { announced, one, none } = await tab.suggestions(3, since);
    assert.deepEqual([announced, one, none], [false, false, true], text);
  }
  // a list seen closed after the typing started and open again counts
  recent.shown = false;
  await tab.suggestions(3, since);
  recent.shown = true;
  assert.ok((await tab.suggestions(3, since)).items.some((i) => i.text === "Recent: Boston, MA"));
});

// pickSuggestion waits only on a field that says it has suggestions: jQuery UI's class, the ARIA combobox attributes,
// a datalist. autocomplete="off" alone is no sign (login forms carry it).
test("test_autocomplete_hint_reads_the_field: a field with an autocomplete hint, and one without", async () => {
  const field = (attrs, classes = []) => ({
    getAttribute: (n) => attrs[n] ?? null,
    hasAttribute: (n) => n in attrs,
    classList: { contains: (c) => classes.includes(c) },
  });
  const hinted = async (el) => {
    const tab = new Tab(7);
    tab.send = async (method, params) => {
      if (method === "DOM.resolveNode") return { object: { objectId: "field" } };
      return { result: { value: vm.runInNewContext(`(${params.functionDeclaration})`).call(el) } };
    };
    return tab.autocompleteHint(3);
  };
  const yes = [
    field({ class: "flight-input ui-autocomplete-input", autocomplete: "off" }, [
      "flight-input",
      "ui-autocomplete-input",
    ]),
    field({ role: "combobox" }),
    field({ "aria-autocomplete": "list" }),
    field({ "aria-controls": "list-1" }),
    field({ "aria-owns": "list-1" }),
    field({ "aria-haspopup": "listbox" }),
    field({ list: "airports" }),
  ];
  for (const el of yes) assert.equal(await hinted(el), true);
  const no = [
    field({ type: "text", autocomplete: "off" }),
    field({ type: "email" }),
    field({ "aria-autocomplete": "none" }),
    field({ "aria-haspopup": "false" }),
  ];
  for (const el of no) assert.equal(await hinted(el), false);
});

// MiniWoB choose-date (round 6): "Select 04/08/2016 as the date"; the field is read-only and its jQuery UI calendar
// opens at December 2016 (clamped to its max date). Tab.setDate clicks the field, reads the calendar (CALENDAR_FN,
// through tab.eval), clicks Prev until the header is the target month, then the day, and reads the field's value.
// The fake calendar here answers each click: the field opens it, Prev and Next move it a month (unless static), a day
// sets the value.
const calendarTab = ({ start = { y: 2016, m: 12 }, moves = true, days, value } = {}) => {
  const tab = new Tab(7);
  const did = [];
  const field = [50, 10],
    prev = [20, 100],
    next = [120, 100];
  let open = false,
    shown = { ...start },
    picked = "";
  const month = (h, by) => {
    const n = h.y * 12 + (h.m - 1) + by;
    return { y: Math.floor(n / 12), m: (n % 12) + 1 };
  };
  tab.centre = async (node) => (did.push(["centre", node]), field);
  tab.click = async (x, y) => {
    did.push(["click", x, y]);
    if (x === field[0] && y === field[1]) open = true;
    else if (x === prev[0] && y === prev[1]) shown = moves ? month(shown, -1) : shown;
    else if (x === next[0] && y === next[1]) shown = moves ? month(shown, 1) : shown;
    else {
      const cell = (days ?? []).find((c) => c.x === x && c.y === y);
      if (cell) picked = `${String(shown.m).padStart(2, "0")}/${String(cell.d).padStart(2, "0")}/${shown.y}`;
    }
  };
  tab.settle = async () => void did.push(["settle"]);
  tab.eval = async () => {
    did.push(["calendar", open ? `${shown.y}-${shown.m}` : null]);
    if (!open) return null;
    const cells =
      days ?? Array.from({ length: 30 }, (_, i) => ({ d: i + 1, x: 200 + i, y: 200, other: false, disabled: false }));
    return { header: { ...shown }, prev, next, days: cells };
  };
  tab.on = async (node, fn) => (did.push(["value", node]), /this\.value/.test(fn) ? (value ?? picked) : null);
  tab.setTemporal = async (node, text) => (did.push(["temporal", node, text]), false);
  return { tab, did, clicks: () => did.filter(([what]) => what === "click").map(([, x, y]) => [x, y]) };
};
const aprilDays = Array.from({ length: 30 }, (_, i) => ({
  d: i + 1,
  x: 300 + 10 * i,
  y: 200,
  other: false,
  disabled: false,
}));

test("test_setdate_clicks_prev_until_header_matches_then_day: Dec 2016 to Apr 2016 is 8 Prev clicks, then day 8", async () => {
  const { tab, did, clicks } = calendarTab({ days: aprilDays });
  assert.deepEqual(await tab.setDate(4, { y: 2016, m: 4, d: 8 }), { ok: true, clicks: 9 });
  const all = clicks();
  assert.deepEqual(all[0], [50, 10]); // the field, at its centre
  assert.deepEqual(all.slice(1, 9), Array(8).fill([20, 100])); // exactly 8 Prev
  assert.deepEqual(all.slice(9), [[370, 200]]); // then day 8's centre, once
  // the header is read after each click, and goes down a month each time
  const headers = did.filter(([what]) => what === "calendar").map(([, h]) => h);
  assert.deepEqual(headers, [
    "2016-12",
    "2016-11",
    "2016-10",
    "2016-9",
    "2016-8",
    "2016-7",
    "2016-6",
    "2016-5",
    "2016-4",
  ]);
  // every click is followed by the settle wait before the next read
  for (let i = 0; i < did.length; i++)
    if (did[i][0] === "click") assert.deepEqual(did[i + 1], ["settle"], `after #${i}`);
  // the value is read last, and the native setter is not needed
  assert.deepEqual(did.at(-1), ["value", 4]);
  assert.equal(did.filter(([what]) => what === "temporal").length, 0);
  // forwards: Next, and no Prev
  const ahead = calendarTab({ start: { y: 2016, m: 2 }, days: aprilDays });
  assert.deepEqual(await ahead.tab.setDate(4, { y: 2016, m: 4, d: 8 }), { ok: true, clicks: 3 });
  assert.deepEqual(ahead.clicks().slice(1), [
    [120, 100],
    [120, 100],
    [370, 200],
  ]);
});

test("test_setdate_stops_when_header_static: Prev that doesn't move the month ends the routine, with no day click", async () => {
  // a calendar at its minimum: its Prev answers nothing
  const { tab, did, clicks } = calendarTab({ moves: false });
  const r = await tab.setDate(4, { y: 2016, m: 4, d: 8 });
  assert.equal(r.ok, false);
  assert.ok(clicks().length <= 2, JSON.stringify(clicks())); // the field and one Prev
  assert.deepEqual(clicks(), [
    [50, 10],
    [20, 100],
  ]);
  assert.equal(r.clicks, 1);
  // then the native date input's setter is tried, with the date in ISO form
  assert.deepEqual(did.at(-1), ["temporal", 4, "2016-04-08"]);
  // no calendar at all: nothing clicked after the field, the native setter decides
  const none = calendarTab();
  none.tab.eval = async () => null;
  none.tab.setTemporal = async () => true; // a native <input type=date readonly>
  assert.deepEqual(await none.tab.setDate(4, { y: 2016, m: 4, d: 8 }), { ok: true, clicks: 0 });
  assert.deepEqual(none.clicks(), [[50, 10]]);
  // the day clicked but the field holds another date: not set
  const wrong = calendarTab({ start: { y: 2016, m: 4 }, days: aprilDays, value: "04/09/2016" });
  assert.deepEqual(await wrong.tab.setDate(4, { y: 2016, m: 4, d: 8 }), { ok: false, clicks: 1 });
});

test("test_setdate_skips_other_month_cell: of two cells for day 8, the other month's (and a disabled one) is skipped", async () => {
  const days = [
    { d: 8, x: 5, y: 150, other: true, disabled: false }, // last month's 8th, shown greyed in the first row
    { d: 8, x: 6, y: 160, other: false, disabled: true },
    ...aprilDays,
  ];
  const { tab, clicks } = calendarTab({ start: { y: 2016, m: 4 }, days });
  assert.deepEqual(await tab.setDate(4, { y: 2016, m: 4, d: 8 }), { ok: true, clicks: 1 });
  assert.deepEqual(clicks(), [
    [50, 10],
    [370, 200],
  ]);
  // only cells of another month or disabled for the day: nothing is clicked in the calendar
  const greyed = calendarTab({ start: { y: 2016, m: 4 }, days: days.slice(0, 2) });
  assert.deepEqual(await greyed.tab.setDate(4, { y: 2016, m: 4, d: 8 }), { ok: false, clicks: 0 });
  assert.deepEqual(greyed.clicks(), [[50, 10]]);
});

// CALENDAR_FN itself, run on a small DOM: every element shown, each with a tag, attributes, its own text, a box (left,
// top, width, height) and a cursor. Tab.setDate reads the calendar through tab.eval, which runs the page script here.
const fakeDom = () => {
  const below = (e) => e.kids.flatMap((k) => [k, ...below(k)]);
  const make = (tag, { attrs = {}, text = "", box = [0, 0, 0, 0], cursor = "auto", kids = [] } = {}) => {
    const e = {
      tagName: tag.toUpperCase(),
      kids,
      box,
      cursor,
      parentElement: null,
      onclick: null,
      getAttribute: (n) => attrs[n] ?? null,
      hasAttribute: (n) => n in attrs,
      getBoundingClientRect: () => {
        const [left, top, width, height] = e.box;
        return { left, top, width, height, right: left + width, bottom: top + height };
      },
      get textContent() {
        return text + kids.map((k) => k.textContent).join("");
      },
      get innerText() {
        return e.textContent;
      },
      get children() {
        return kids;
      },
      get nextElementSibling() {
        const sib = e.parentElement?.kids ?? [];
        return sib[sib.indexOf(e) + 1] ?? null;
      },
      contains: (o) => {
        for (let x = o; x; x = x.parentElement) if (x === e) return true;
        return false;
      },
      matches: (sel) =>
        sel.split(",").some((part) => {
          const m = /^\[([\w-]+)(?:=([\w-]+))?\]$/.exec(part.trim());
          return m ? (m[2] === undefined ? m[1] in attrs : attrs[m[1]] === m[2]) : part.trim() === tag;
        }),
      closest: (sel) => {
        for (let x = e; x; x = x.parentElement) if (x.matches(sel)) return x;
        return null;
      },
      getElementsByTagName: () => below(e),
    };
    for (const k of kids) k.parentElement = e;
    return e;
  };
  const run = (bodyKids) => {
    const body = make("body", { kids: bodyKids, box: [0, 0, 1280, 800] });
    const html = make("html", { kids: [body], box: [0, 0, 1280, 800] });
    const ctx = vm.createContext({
      document: {
        body,
        documentElement: html,
        querySelectorAll: (s) => (s === "body *" ? below(body) : below(html).filter((x) => x.matches(s))),
      },
      getComputedStyle: (x) => ({ visibility: "visible", display: "block", opacity: "1", cursor: x.cursor }),
    });
    return (expr) => JSON.parse(JSON.stringify(vm.runInContext(expr, ctx) ?? null));
  };
  // December 2016 on a 7-column grid of buttons below its header row (y 40..60)
  const days = () =>
    Array.from({ length: 31 }, (_, i) =>
      make("button", { text: String(i + 1), box: [20 + 30 * (i % 7), 70 + 20 * Math.floor(i / 7), 28, 18] }),
    );
  const header = () => make("h2", { text: "December 2016", box: [80, 40, 100, 20] });
  return { make, run, days, header };
};
const domTab = (evaluate) => {
  const tab = new Tab(7);
  const clicks = [];
  tab.centre = async () => [500, 10];
  tab.click = async (x, y) => void clicks.push([x, y]);
  tab.settle = async () => {};
  tab.eval = async (expr) => evaluate(expr);
  tab.on = async () => "12/08/2016";
  tab.setTemporal = async () => false;
  return { tab, clicks };
};

test("test_calendar_never_body: a calendar found only by taking in the page's own Back and Next is no calendar", async () => {
  const { make, run, days, header } = fakeDom();
  const back = () => make("a", { attrs: { href: "#back" }, text: "Back", box: [10, 40, 40, 20] });
  const formNext = () => make("button", { attrs: { type: "submit" }, text: "Next", box: [230, 40, 40, 20] });
  // the arrows the calendar draws are unrecognised (no word, no label, no pointer): only the page's Back and Next,
  // on the header's row, could serve; with everything straight in the body, the body would be the box
  const loose = domTab(
    run([
      back(),
      make("span", { text: "◀", box: [40, 40, 20, 20] }),
      header(),
      make("span", { text: "▶", box: [200, 40, 20, 20] }),
      ...days(),
      formNext(),
    ]),
  );
  assert.deepEqual(await loose.tab.setDate(4, { y: 2016, m: 4, d: 8 }), { ok: false, clicks: 0 });
  assert.deepEqual(loose.clicks, [[500, 10]]); // the field only: neither Back nor Next is clicked
  // the same calendar in a box of its own, with the page's Back and Next in that box too but not on its header's row
  // or beside it: still no calendar
  const boxed = domTab(
    run([
      make("div", {
        box: [0, 0, 700, 400],
        kids: [
          make("a", { attrs: { href: "#back" }, text: "Back", box: [600, 40, 40, 20] }),
          make("span", { text: "◀", box: [40, 40, 20, 20] }),
          header(),
          make("span", { text: "▶", box: [200, 40, 20, 20] }),
          ...days(),
          make("button", { attrs: { type: "submit" }, text: "Next", box: [230, 300, 40, 20] }),
        ],
      }),
    ]),
  );
  assert.deepEqual(await boxed.tab.setDate(4, { y: 2016, m: 4, d: 8 }), { ok: false, clicks: 0 });
  assert.deepEqual(boxed.clicks, [[500, 10]]);
  // arrows the calendar marks as its own (bootstrap's <th class="prev">«</th>: the pointer cursor, no link or button),
  // with the page's Back and Next around it: the calendar's arrows are found, the page's controls never used
  const evaluate = run([
    back(),
    make("div", {
      box: [15, 35, 220, 160],
      kids: [
        make("th", { attrs: { class: "prev" }, text: "«", cursor: "pointer", box: [40, 40, 20, 20] }),
        header(),
        make("th", { attrs: { class: "next" }, text: "»", cursor: "pointer", box: [200, 40, 20, 20] }),
        ...days(),
      ],
    }),
    formNext(),
  ]);
  const reads = [];
  const found = domTab((expr) => (reads.push(evaluate(expr)), reads.at(-1)));
  assert.deepEqual(await found.tab.setDate(4, { y: 2016, m: 12, d: 8 }), { ok: true, clicks: 1 });
  const [cal] = reads;
  assert.deepEqual([cal.header, cal.prev, cal.next, cal.days.length], [{ y: 2016, m: 12 }, [50, 50], [210, 50], 31]);
  assert.deepEqual(found.clicks, [
    [500, 10],
    [34, 99], // day 8: the second row's first button (20..48, 90..108)
  ]);
});

// copyMove: Tab.copyInto reads one element's value (innerText for a non-field), focuses the other, empties it and
// inserts the text, then tells the page's frameworks
const copyTab = (source) => {
  const tab = new Tab(7);
  const did = [];
  tab.on = async (node) => (did.push(["on", node]), source);
  tab.click = async (x, y) => void did.push(["click", x, y]);
  tab.centre = async () => [50, 60];
  tab.clearField = async () => void did.push(["clear"]);
  tab.caretToEnd = async () => void did.push(["caret"]);
  tab.eval = async () => void did.push(["eval"]);
  tab.send = async (method, params = {}) => {
    if (method === "DOM.resolveNode") return { object: { objectId: `node${params.backendNodeId}` } };
    if (method === "Input.insertText") did.push(["insert", params.text]);
    return {};
  };
  return { tab, did };
};

test("test_copy_innertext_source: a source with no value is read by its innerText; one with neither inserts nothing", async () => {
  let read;
  const t = copyTab("Lorem ipsum");
  t.tab.on = async (node, fn) => ((read = fn), "Lorem ipsum");
  assert.deepEqual(await t.tab.copyInto(2, 3), { chars: 11 });
  assert.match(read, /innerText/);
  assert.match(read, /this\.value/);
  assert.deepEqual(
    t.did.find(([w]) => w === "insert"),
    ["insert", "Lorem ipsum"],
  );
  const none = copyTab("");
  assert.deepEqual(await none.tab.copyInto(2, 3), { chars: 0 });
  assert.equal(none.did.filter(([w]) => w === "insert" || w === "clear").length, 0);
});

test("test_copyinto_clears_then_inserts: the target is focused, emptied, given the source's text, then notified", async () => {
  const { tab, did } = copyTab("a\nb");
  assert.deepEqual(await tab.copyInto(2, 3), { chars: 3 });
  const order = did.map(([w]) => w).filter((w) => w !== "on");
  assert.deepEqual(order.slice(0, 3), ["click", "clear", "insert"]);
  assert.deepEqual(
    did.find(([w]) => w === "click"),
    ["click", 50, 60],
  );
  assert.equal(did.find(([w]) => w === "insert")[1], "a\nb");
  assert.equal(order.at(-1), "eval");
});

test("test_copyinto_appends_into_document_editor: a document-editor target gets the caret at its end and is never cleared", async () => {
  const { tab, did } = copyTab("hello");
  assert.deepEqual(await tab.copyInto(2, 3, true), { chars: 5 });
  const order = did.map(([w]) => w);
  assert.ok(order.indexOf("caret") > order.indexOf("click") && order.indexOf("caret") < order.indexOf("insert"));
  assert.ok(!order.includes("clear"));
});
