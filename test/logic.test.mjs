import assert from "node:assert/strict";
import { test } from "node:test";
import * as L from "../src/logic.ts";

const el = (label, text, extra = {}) => ({ label, text, state: "", box: [0, 0, 10, 10], ...extra });

test("resolveTexts fills {{name}} from notes and drops empty texts", () => {
  const out = L.resolveTexts(
    [
      { name: "body", text: "Top:\n{{notes}}" },
      { name: "x", text: "" },
      { name: "q", text: "{{missing}}" },
    ],
    { notes: "a\nb" },
  );
  assert.deepEqual(out, [
    { name: "body", text: "Top:\na\nb" },
    { name: "q", text: "{{missing}}" },
  ]);
});

test("buildOptions: one move per field and text when there are few texts, plus click", () => {
  const texts = [{ name: "query", text: "almaty weather" }];
  const { opts, acts } = L.buildOptions({
    els: [el("E1", "combobox 'Search'", { field: true }), el("E2", "button 'Google Search'")],
    texts,
  });
  assert.equal(acts["type query into E1"].kind, "type");
  assert.equal(acts["type query into E1"].text.text, "almaty weather");
  assert.equal(acts["click E1"].kind, "click");
  assert.equal(acts["click E2"].kind, "click");
  assert.equal(acts["type query at the cursor"].kind, "type_cursor");
  assert.match(opts["type query into E1"], /'almaty weather'/);
  for (const k of ["scroll down", "back", "step done", "ask user", "ask for help"]) assert.ok(k in acts, k);
});

test("buildOptions: many texts make one 'type into' move per field", () => {
  const texts = ["a", "b", "c", "d", "e"].map((n) => ({ name: n, text: n.repeat(3) }));
  const { acts } = L.buildOptions({ els: [el("E1", "textbox 'Name'", { field: true })], texts });
  assert.equal(acts["type into E1"].kind, "type_pick");
  assert.ok(!("type a into E1" in acts));
});

test("buildOptions: dropdown options inline, skipping the selected one; offscreen elements", () => {
  const sel = el("E1", "dropdown 'Country'", { select: true, options: ["Kazakhstan", "Japan", ""], selectedIndex: 0 });
  const off = [
    { label: "D1", text: "button 'Next'", where: "1.2 screens down" },
    { label: "D2", text: "textbox 'Email'", field: true, where: "0.5 screens up" },
  ];
  const { acts, opts } = L.buildOptions({ els: [sel], off });
  assert.ok(!("choose 'Kazakhstan' in E1" in acts));
  assert.equal(acts["choose 'Japan' in E1"].index, 1);
  assert.equal(acts["click D1"].kind, "scroll_click");
  assert.equal(acts["scroll to D2"].kind, "scroll_to");
  assert.match(opts["click D1"], /1\.2 screens down/);
});

test("buildOptions: tab switching lists other tabs", () => {
  const { acts, opts } = L.buildOptions({ tabs: [{ id: 7, title: "Inbox", url: "https://mail.google.com/mail/u/0" }] });
  assert.equal(acts["switch to tab 1"].tab.id, 7);
  assert.match(opts["switch to tab 1"], /mail\.google\.com/);
});

test("isRisky flags paying, sending and deleting clicks only", () => {
  const click = (text) => ({ kind: "click", el: { text } });
  assert.ok(L.isRisky(click("button 'Send'")));
  assert.ok(L.isRisky(click("button 'Place your order'")));
  assert.ok(L.isRisky(click("button 'Delete draft'")));
  assert.ok(!L.isRisky(click("link 'Sending money abroad: a guide'")));
  assert.ok(!L.isRisky(click("button 'Google Search'")));
  assert.ok(!L.isRisky({ kind: "key", key: "Enter" }));
  // a long name is content, not a control: an email row whose preview says "Send any amount..."
  assert.ok(
    !L.isRisky({
      kind: "click",
      el: { name: "Crypto Max Double your Bitcoin - Send any amount of BTC to the wallet below", text: "link '...'" },
    }),
  );
  assert.ok(L.isRisky({ kind: "click", el: { name: "Send", text: "button 'Send'" } }));
});

// Approval stops on harmless controls: a date picker named "Check in / Check out Anytime" matched "check out"; the gate now reads the whole name, and still stops every act that sends, pays,
// posts, books, subscribes or deletes.
test("isRisky reads the whole name: a field's or a filter's name is not the act, the act still is", () => {
  const click = (name, role = "button") => ({ kind: "click", el: { name, role, text: `${role} '${name}'` } });
  for (const name of [
    "Check in / Check out Anytime",
    "Check-in date Check-out date",
    "Checkout date",
    "Remove filter: 2 Star Review",
    "Clear all filters",
    "Date posted",
    "Check out our deals",
  ])
    assert.ok(!L.isRisky(click(name)), name);
  // choosing a value commits nothing: the box, the option or the tab, not the button that submits the choice
  assert.ok(!L.isRisky(click("Subscribe & Save", "radio")));
  assert.ok(!L.isRisky(click("Email me deals (subscribe)", "checkbox")));
  assert.ok(!L.isRisky(click("Post date", "option")));
  for (const name of [
    "Checkout",
    "Proceed to checkout",
    "Check out",
    "Place your order",
    "Pay now",
    "Subscribe",
    "Delete",
    "Remove item",
    "Book now",
    "Reserve",
    "Post",
    "Send message",
    "Publish",
    // an act whose name only looks like a field's or an advert's
    "Post on Facebook",
    "Post on X",
    "Check out the cart",
    "Check out all items",
    // a field's or a filter's phrase excuses only itself, not another act in the same name
    "Reserve: check-in 3/3, checkout 3/5",
    "Book now · Check in / Check out",
    "Delete and reset filters",
    "Delete post date",
    // an act between the verb and the filter it names is not excused with it
    "Remove item and clear filters",
  ])
    assert.ok(L.isRisky(click(name)), name);
  assert.ok(!L.isRisky(click("Posted on Oct 3")));
  assert.ok(L.isRisky(click("Delete", "menuitem")));
  // an action menu built as a listbox: its option acts on the click
  assert.ok(L.isRisky(click("Delete conversation", "option")));
  assert.ok(L.isRisky(click("Auto-renew: subscribe", "switch"))); // a settings switch may save at once
});

test("pointRisk: a point click asks only when what is under it may send, pay or delete, or can't be read", () => {
  const at = (over = {}) => ({
    names: [],
    role: "",
    marks: [],
    submits: false,
    frame: false,
    payment: false,
    key: "k",
    ...over,
  });
  // harmless clicks that used to stop for approval: a chart range option, a quiz tile, a filter button, a place panel
  assert.equal(L.pointRisk(at({ names: ["1 year"], role: "option" })), "");
  assert.equal(L.pointRisk(at({ names: ["Multiplication"], role: "link" })), "");
  assert.equal(L.pointRisk(at({ names: ["Filters"], role: "button" })), "");
  assert.equal(L.pointRisk(at({ names: ["Reviews", "Global Gas Station 4.3 Gas station"] })), "");
  assert.equal(L.pointRisk(at({ names: ["Subscribe to updates"], role: "checkbox" })), "");
  // a named icon inside a choosing control is not the choice
  assert.match(L.pointRisk(at({ names: ["Delete sheet", "Sheet1"], own: ["Sheet1"], role: "tab" })), /Delete sheet/);
  assert.match(L.pointRisk(at({ names: ["Remove", "Item 2"], own: ["Item 2"], role: "option" })), /Remove/);
  assert.equal(
    L.pointRisk(at({ names: ["Subscribe to updates"], own: ["Subscribe to updates"], role: "checkbox" })),
    "",
  );
  // still stopped: a named act, an icon-only Delete, a form that sends, an embedded frame, a card page, the unknown
  assert.match(L.pointRisk(at({ names: ["Delete photo"], role: "button" })), /Delete photo/);
  assert.match(L.pointRisk(at({ names: ["", "Place order"], role: "button" })), /Place order/);
  assert.match(L.pointRisk(at({ role: "button", marks: ["trash"] })), /trash/);
  assert.match(
    L.pointRisk(at({ names: ["delete_outline", "Photo, Oct 3 delete_outline"], role: "link" })),
    /delete_outline/,
  );
  assert.match(L.pointRisk(at({ names: ["🗑"], role: "button" })), /no name/);
  assert.match(L.pointRisk(at({ names: ["×"], role: "button" })), /no name/);
  assert.match(L.pointRisk(at({ names: ["Go"], role: "button", submits: true })), /submits a form/);
  assert.match(L.pointRisk(at({ frame: true })), /embedded frame/);
  assert.match(
    L.pointRisk(at({ frame: true, frameInfo: "https://js.stripe.com/v3/elements-inner-card" })),
    /embedded frame/,
  );
  // a consent manager's frame takes privacy choices only (Porsche's cookie dialog)
  assert.equal(
    L.pointRisk(at({ frame: true, frameInfo: "https://cdn.privacy-mgmt.com/index.html SP Consent Message" })),
    "",
  );
  assert.equal(
    L.pointRisk(at({ frame: true, frameInfo: "https://consent.trustarc.com/ TrustArc Cookie Consent Manager" })),
    "",
  );
  // a frame is judged by its host, title, id and name, not by words in its address's path or query
  assert.match(L.pointRisk(at({ frame: true, frameInfo: "https://www.paypal.com/checkoutnow?cookie=1" })), /frame/);
  assert.match(L.pointRisk(at({ frame: true, frameInfo: "https://pay.example.com/?cmp=abc" })), /frame/);
  assert.match(L.pointRisk(at({ frame: true, frameInfo: "https://accounts.google.com/o/oauth2/consent" })), /frame/);
  assert.match(L.pointRisk(at({ frame: true, frameInfo: "//pay.example.com/checkout?cookie=1 Payment" })), /frame/);
  // a nameless icon laid over a named tile (a Delete revealed on hover) is not the tile
  assert.match(L.pointRisk(at({ names: ["Photo, Oct 3"], role: "link", overlay: true })), /icon with no name/);
  // a button with no name and no mark could be an icon-only Delete; a nameless link (an image tile) opens a page
  assert.match(L.pointRisk(at({ role: "button" })), /no name/);
  assert.equal(L.pointRisk(at({ role: "link" })), "");
  assert.match(L.pointRisk(at({ names: ["Continue"], role: "button", payment: true })), /card details/);
  assert.match(L.pointRisk(null), /could not be read/);
  // a nameless close in a cookie or consent banner (Porsche) goes; a named act, a mark or a form there still asks
  assert.equal(L.pointRisk(at({ role: "button", consent: true })), "");
  assert.equal(L.pointRisk(at({ names: ["Required Only", "Required Only Accept All"], overlay: true })), "");
  assert.equal(L.pointRisk(at({ names: ["Accept All"], role: "button" })), "");
  assert.notEqual(L.pointRisk(at({ names: ["Accept offer"], role: "button", overlay: true })), "");
  assert.notEqual(L.pointRisk(at({ names: ["Accept All"], role: "button", submits: true })), "");
  assert.match(L.pointRisk(at({ names: ["Delete my account"], role: "button", consent: true })), /Delete my account/);
  assert.match(L.pointRisk(at({ role: "button", marks: ["trash"], consent: true })), /trash/);
  assert.notEqual(L.pointRisk(at({ role: "button", submits: true, consent: true })), "");
  assert.match(L.pointRisk(at({ role: "button", payment: true, consent: true })), /card details/);
});

// Runs opened google.com instead of the site's own Research, Events or Investments menu, and ended at reCAPTCHA. A run stays on the task's website unless the task is about a search engine.
test("a run stays on the task's website: search engine steps continue on the site", () => {
  assert.equal(L.isSearchEngine("https://www.google.com/search?q=nvidia+lab"), true);
  assert.equal(L.isSearchEngine("https://www.google.com/sorry/index?continue=x"), true);
  assert.equal(L.isSearchEngine("https://duckduckgo.com/?q=x"), true);
  assert.equal(L.isSearchEngine("https://www.google.com/maps/"), false); // a website of its own
  assert.equal(L.isSearchEngine("https://www.google.com/shopping?udm=28"), false);
  assert.equal(L.isSearchEngine("https://www.nvidia.com/search?q=x"), false);
  assert.equal(L.taskSite("Open the lab leader's page.", "https://www.nvidia.com/"), "https://www.nvidia.com/");
  assert.equal(L.taskSite("Search Google for the lab leader.", "https://www.nvidia.com/"), null);
  assert.equal(L.taskSite("Find monitors.", "https://www.google.com/"), null);
  assert.equal(L.taskSite("Find monitors.", "chrome://newtab/"), null);
  // a product or another service of a search engine's company is not a search engine
  assert.equal(L.taskSite("Find a Google Pixel 9 under $500.", "https://www.bestbuy.com/"), "https://www.bestbuy.com/");
  assert.equal(L.taskSite("Find the route on Google Maps.", "https://www.nvidia.com/"), "https://www.nvidia.com/");
  assert.equal(L.taskSite("Find it with a web search.", "https://www.nvidia.com/"), null);
  const steps = [
    { kind: "browse", goal: "find it", open_url: "https://www.google.com/search?q=lab", use_tab: 2 },
    { kind: "browse", goal: "open it", open_url: "https://research.nvidia.com/labs/", use_tab: -1 },
  ];
  const kept = L.stayOnSite(steps, "https://www.nvidia.com/");
  assert.deepEqual(kept.dropped, ["https://www.google.com/search?q=lab"]);
  assert.equal(kept.steps[0].open_url, "");
  assert.equal(kept.steps[0].use_tab, -1);
  assert.equal(kept.steps[1].open_url, "https://research.nvidia.com/labs/");
  assert.deepEqual(L.stayOnSite(steps, null).dropped, []);
});

test("answerTokens: the distinctive bits of an answer to find on the page, longest first", () => {
  assert.deepEqual(L.answerTokens("The recommended dose is 380 mg once a month, about $1,239,722 in 2026."), [
    "$1,239,722",
    "1,239,722",
    "380 mg",
  ]);
  assert.deepEqual(L.answerTokens('Opened "Undaunted: Stalingrad Board Game Review" (score 10).'), [
    "Undaunted: Stalingrad Board Game Review",
  ]);
  assert.deepEqual(L.answerTokens("Done in 2026."), []);
  assert.deepEqual(L.answerTokens(null), []);
});

test("keepPage: a replan doesn't reopen the site's home page or the page the run is on in a new tab", () => {
  const here = "https://www.compass.com/homes-for-sale/tucson-az-85747/has-pool/";
  const steps = [
    { kind: "browse", goal: "home", open_url: "https://www.compass.com/", use_tab: 3 },
    { kind: "browse", goal: "same page", open_url: here, use_tab: -1 },
    { kind: "browse", goal: "another page of the site", open_url: "https://www.compass.com/agents/", use_tab: -1 },
    { kind: "browse", goal: "page 2", open_url: `${here}?page=2`, use_tab: -1 },
    { kind: "browse", goal: "another site", open_url: "https://www.zillow.com/", use_tab: -1 },
    { kind: "browse", goal: "localized home", open_url: "https://compass.com/en-us/", use_tab: -1 },
    { kind: "browse", goal: "a two-letter category", open_url: "https://www.compass.com/tv", use_tab: -1 },
  ];
  const kept = L.keepPage(steps, here);
  assert.deepEqual(kept.dropped, ["https://www.compass.com/", here, "https://compass.com/en-us/"]);
  assert.deepEqual(
    kept.steps.map((s) => s.open_url),
    [
      "",
      "",
      "https://www.compass.com/agents/",
      `${here}?page=2`,
      "https://www.zillow.com/",
      "",
      "https://www.compass.com/tv",
    ],
  );
  assert.equal(kept.steps[0].use_tab, -1);
  assert.deepEqual(L.keepPage(steps, "").dropped, []);
});

test("stallReason: a repeat of a recent dead move, or three dead moves in a row", () => {
  const dead = (what) => ({ what, changed: false });
  assert.match(
    L.stallReason([dead("clicked x"), { what: "scrolled down", changed: true }], "clicked x"),
    /repeat 'clicked x'/,
  );
  assert.equal(L.stallReason([{ what: "clicked x", changed: true }], "clicked x"), "");
  assert.equal(L.stallReason([], "clicked x"), "");
  assert.match(
    L.stallReason([dead("pressed Tab"), dead("pressed Enter"), dead("wait")], "scrolled down"),
    /last 3 moves changed nothing/,
  );
  assert.equal(
    L.stallReason([dead("pressed Tab"), { what: "clicked y", changed: true }, dead("wait")], "scrolled down"),
    "",
  );
});

test("stateText tells Drex when nothing could be tagged", () => {
  const plan = { steps: [{ kind: "browse", goal: "g", done_when: "d" }] };
  const args = { task: "t", plan, index: 0, texts: [], history: [], info: { title: "x", url: "u" } };
  assert.match(L.stateText({ ...args, tagged: 0 }), /nothing on this screen could be tagged/);
  assert.doesNotMatch(L.stateText({ ...args, tagged: 3 }), /could be tagged/);
});

test("stateText shows the plan position, texts, history and a repeat warning", () => {
  const plan = {
    steps: [
      { kind: "browse", goal: "Open HN", done_when: "Is HN open?" },
      { kind: "read", goal: "Write the top 5" },
    ],
  };
  const history = [
    { what: "clicked a", changed: false },
    { what: "clicked a", changed: false },
  ];
  const s = L.stateText({
    task: "t",
    plan,
    index: 0,
    texts: [{ name: "q", text: "hn" }],
    history,
    info: { title: "Hacker News", url: "https://news.ycombinator.com" },
  });
  assert.match(s, /1\. \[NOW\] Open HN/);
  assert.match(s, /2\. \(the LLM reads the page\) Write the top 5/);
  assert.match(s, /IT IS DONE WHEN: Is HN open\?/);
  assert.match(s, /- q: 'hn'/);
  assert.match(s, /nothing changed on screen/);
  assert.match(s, /WARNING: you are repeating yourself \(clicked a\)/);
});

test("whatOf describes typed text given as a string", () => {
  const long = "x".repeat(80);
  assert.equal(L.whatOf({ kind: "type", el: { text: "textbox 'Q'" } }, "almaty"), "typed 'almaty' into textbox 'Q'");
  assert.match(L.whatOf({ kind: "type_cursor" }, long), /\(80 characters\)/);
});

test("moveBudget comes from the plan, within bounds; rescues scale with it", () => {
  assert.equal(L.moveBudget({}), L.DEFAULT_MOVES);
  assert.equal(L.moveBudget({ max_moves: 120 }), 120);
  assert.equal(L.moveBudget({ max_moves: 2 }), L.MIN_MOVES);
  assert.equal(L.moveBudget({ max_moves: 5000 }), L.MAX_MOVES);
  assert.equal(L.rescueBudget(25), 4);
  assert.equal(L.rescueBudget(120), 12);
});

test("moveBudget clamps and defaults", () => {
  assert.equal(L.moveBudget({ max_moves: 0 }), L.DEFAULT_MOVES);
  assert.equal(L.moveBudget({ max_moves: -3 }), L.DEFAULT_MOVES);
  assert.equal(L.moveBudget({ max_moves: "abc" }), L.DEFAULT_MOVES);
  assert.equal(L.moveBudget({ max_moves: 7.6 }), 8);
  assert.equal(L.moveBudget({ max_moves: 600 }), L.MAX_MOVES);
});

test("guardSteps blanks untrusted open_url and keeps everything else", () => {
  const steps = [
    { kind: "teleport", goal: "g", open_url: "https://a.com/x" },
    { kind: "browse", goal: "h", open_url: "https://evil.com/y", extra: 1 },
    { kind: "read", goal: "i" },
    { kind: "browse", goal: "j", open_url: "not a url" },
  ];
  const r = L.guardSteps(steps, new Set(["https://a.com"]));
  assert.deepEqual(r.steps, [
    steps[0],
    { kind: "browse", goal: "h", open_url: "", extra: 1 },
    steps[2],
    { kind: "browse", goal: "j", open_url: "" },
  ]);
  assert.equal(r.steps[0], steps[0]);
  assert.deepEqual(r.dropped, ["https://evil.com/y", "not a url"]);
  assert.equal(steps[1].open_url, "https://evil.com/y");
});

test("document editors are typed into at the end, single-line fields and form text areas are replaced", () => {
  const texts = [{ name: "body", text: "hello" }];
  const { opts } = L.buildOptions({
    els: [
      el("E1", "textbox 'Doc'", { field: true, multi: true }),
      el("E2", "textbox 'Title'", { field: true }),
      el("E3", "textbox 'Bio'", { field: true, multi: true, textarea: true }),
    ],
    texts,
  });
  assert.match(opts["type body into E1"], /at the end of textbox 'Doc'.*adds to what it holds/);
  assert.match(opts["type body into E2"], /into textbox 'Title'.*replaces what it holds/);
  // typeInto empties a text area first: the move must not promise to keep what it holds
  assert.match(opts["type body into E3"], /into textbox 'Bio'.*replaces what it holds/);
});

test("stateText: rules, site notes and move count; no repeat warning for repeats that changed the screen", () => {
  const plan = {
    steps: [{ kind: "browse", goal: "File every email", done_when: "Is the inbox empty?", rules: "Junk = scams." }],
  };
  const history = [
    { what: "clicked button 'Move to Junk'", changed: true },
    { what: "clicked button 'Move to Junk'", changed: true },
  ];
  const s = L.stateText({
    task: "t",
    plan,
    index: 0,
    texts: [],
    history,
    info: { title: "x", url: "u" },
    moves: 40,
    budget: 120,
    site: { name: "Gmail", screen_tips: "Do not press Tab in To." },
  });
  assert.match(s, /RULES FOR YOUR DECISIONS IN THIS STEP:\nJunk = scams\./);
  assert.match(s, /NOTES ABOUT GMAIL: Do not press Tab in To\./);
  assert.match(s, /\(40 of at most 120;/);
  assert.doesNotMatch(s, /WARNING/);
});

test("isStepDone: a borderline done check does not end a step Drex is confidently continuing", () => {
  // the Google Flights run: done check 62% on the booking-options page while Drex picked a booking option at 87.5%
  assert.equal(L.isStepDone(0.621, "click D1", 0.875), false);
  assert.equal(L.isStepDone(0.9, "click D1", 0.95), true); // a sure done check wins
  assert.equal(L.isStepDone(0.7, "click E3", 0.4), true); // done check more confident than the move
  assert.equal(L.isStepDone(0.65, "step done", 0.8), true); // Drex itself says done
  assert.equal(L.isStepDone(0.577, "step done", 0.9), false); // DoorDash checkout: 58% on the screen check is not enough
  assert.equal(L.isStepDone(0.3, "step done", 0.8), false); // ...but its screen check disagrees
  assert.equal(L.isStepDone(0.2, "click E3", 0.9), false);
});

test("controls that share a label are told apart by their card's text, in options and in the history", () => {
  const add = (label, context) => el(label, "button 'Add item to cart'", { context });
  const { opts } = L.buildOptions({ els: [add("E1", "Kung Pao Chicken $15.95"), add("E2", "Coca-Cola $3.25")] });
  assert.match(opts["click E2"], /Click button 'Add item to cart' \(in "Coca-Cola \$3\.25"\)/);
  assert.equal(
    L.whatOf({ kind: "click", el: add("E2", "Coca-Cola $3.25") }),
    `clicked button 'Add item to cart' (in "Coca-Cola $3.25")`,
  );
  assert.equal(L.describe(el("E3", "button 'Search'")), "button 'Search'"); // a unique label stays as it is
});
