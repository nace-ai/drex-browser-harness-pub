import assert from "node:assert/strict";
import { test } from "node:test";
import * as L from "../src/logic.ts";

const home = {
  url: "https://food.example/home",
  texts: ["button '10 Cambridge Ave'", "searchbox 'Search'", "link 'Chicken Hut'", "link 'Taco Yurt'", "link 'Cart'"],
};
const picker = {
  url: "https://food.example/home",
  texts: ["dialog 'Address'", "radio '10 Cambridge Ave'", "radio '12 Market St'", "button 'Save'", "button 'Close'"],
};
const move = (what, screen, changed = true) => ({ what, screen, changed });

test("findLoop: the DoorDash circle (open the address picker, close it, again) is a loop of 2 moves", () => {
  const h = [
    move("clicked '10 Cambridge Ave'", home),
    move("clicked 'Close'", picker),
    move("clicked '10 Cambridge Ave'", home),
    move("clicked 'Close'", picker),
  ];
  assert.deepEqual(L.findLoop(h), { period: 2, moves: ["clicked '10 Cambridge Ave'", "clicked 'Close'"] });
  assert.equal(L.findLoop(h.slice(0, 3)), null); // not yet twice round
});

test("findLoop: filing a different email each time is not a loop", () => {
  const inbox = (n) => ({
    url: "https://mail.example/#inbox",
    texts: ["button 'Report spam'", ...Array.from({ length: 20 }, (_, i) => `checkbox 'email ${n + i}'`)],
  });
  const h = [];
  for (let n = 0; n < 4; n++)
    h.push(move(`clicked checkbox 'email ${n}'`, inbox(n)), move("clicked 'Report spam'", inbox(n)));
  assert.equal(L.findLoop(h), null);
});

test("findLoop: one move repeated needs three rounds on near-identical screens (paging and scrolling are not loops)", () => {
  const page = (n) => ({
    url: `https://shop.example/s?page=${n}`,
    texts: ["link 'Next'", `link 'item ${n}a'`, `link 'item ${n}b'`],
  });
  assert.equal(L.findLoop([1, 2, 3, 4].map((n) => move("clicked 'Next'", page(n)))), null); // URL changes each page
  const same = [1, 2, 3].map(() => move("pressed Escape", home));
  assert.deepEqual(L.findLoop(same), { period: 1, moves: ["pressed Escape"] });
  assert.equal(L.findLoop(same.slice(0, 2)), null);
});

test("findLoop: moves that changed nothing are left to stallReason, and a loop marker restarts the count", () => {
  const dead = [1, 2, 3, 4].map((i) => move(i % 2 ? "pressed Tab" : "pressed Enter", home, false));
  assert.equal(L.findLoop(dead), null);
  const h = [move("a", home), move("b", picker), move("a", home), move("b", picker), { marker: true }, move("a", home)];
  assert.equal(L.findLoop(h), null);
});

test("similarScreens: same page with a small change is similar; another URL is not", () => {
  assert.ok(L.similarScreens(home, { ...home, texts: [...home.texts.slice(0, 4), "link 'Cart (1)'"] }) === false); // 4 of 6 shared
  assert.ok(L.similarScreens(home, { ...home }));
  assert.ok(!L.similarScreens(home, { ...home, url: "https://food.example/cart" }));
});

test("stateText shows a loop note when there is one, and hides loop markers from the move list", () => {
  const plan = { steps: [{ kind: "browse", goal: "g", done_when: "d" }] };
  const s = L.stateText({
    task: "t",
    plan,
    index: 0,
    texts: [],
    history: [move("a", home), { marker: true }],
    info: { title: "x", url: "u" },
    loop: { period: 2, moves: ["clicked '10 Cambridge Ave'", "clicked 'Close'"] },
  });
  assert.match(s, /LOOP: .*clicked '10 Cambridge Ave' -> clicked 'Close'/);
  assert.doesNotMatch(s, /marker|undefined/);
});

test("withoutMoves drops the paused moves but never leaves Drex without a real move", () => {
  const els = [
    { label: "E1", text: "button '10 Cambridge Ave'", state: "", box: [0, 0, 1, 1] },
    { label: "E2", text: "link 'Chicken Hut'", state: "", box: [0, 0, 1, 1] },
  ];
  const all = L.buildOptions({ els });
  const { acts } = L.withoutMoves(all, new Set(["clicked button '10 Cambridge Ave'"]));
  assert.ok(!("click E1" in acts));
  assert.ok("click E2" in acts && "ask for help" in acts);
  const only = L.buildOptions({ els: els.slice(0, 1) });
  const kept = L.withoutMoves(
    {
      opts: { "click E1": only.opts["click E1"], stuck: "x" },
      acts: { "click E1": only.acts["click E1"], stuck: { kind: "stuck" } },
    },
    new Set(["clicked button '10 Cambridge Ave'"]),
  );
  assert.ok("click E1" in kept.acts); // nothing real left otherwise: keep it
});

test("scrollRun: scrolls in a row at the end of the history, since the last loop marker", () => {
  const scrolls = (n) => Array.from({ length: n }, (_, i) => move(i % 2 ? "scrolled up" : "scrolled down", home));
  assert.equal(L.scrollRun(scrolls(4)), 4);
  assert.equal(L.scrollRun([...scrolls(3), move("clicked 'Filters'", home)]), 0);
  assert.equal(L.scrollRun([...scrolls(3), { marker: true }, ...scrolls(1)]), 1);
  // scrolling to a control and clicking it acts on the page
  assert.equal(L.scrollRun([...scrolls(2), move("scrolled to and clicked button 'Apply'", home)]), 0);
});

test("findLoop: a 7-move search, sort and filter circle, twice round, is a loop", () => {
  const list = { url: "https://shop.example/catalogsearch", texts: ["searchbox 'Search'", "combobox 'Sort By'"] };
  const circle = [
    "typed 'shoe organizer' into searchbox 'Search'",
    "chose 'Price' in combobox 'Sort By'",
    "clicked 'Set Ascending Direction'",
    "hovered 'Home & Kitchen'",
    "hovered 'Storage & Organization'",
    "clicked 'Shoe Organizers'",
    "chose 'Relevance' in combobox 'Sort By'",
  ];
  const h = [...circle, ...circle].map((what) => move(what, list));
  assert.deepEqual(L.findLoop(h), { period: 7, moves: circle });
  assert.equal(L.findLoop(h.slice(0, 12)), null); // not yet twice round
});
