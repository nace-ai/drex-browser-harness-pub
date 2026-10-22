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

// test_error_statuses_from_format
test("errorStatuses: the status values a task's answer format offers for a failure", () => {
  const webarena =
    'Do the task.\nReturn exactly one JSON object with exactly these four fields:\n{"task_type":"RETRIEVE"|"MUTATE"|"NAVIGATE","status":"SUCCESS"|"ACTION_NOT_ALLOWED_ERROR"|"PERMISSION_DENIED_ERROR"|"NOT_FOUND_ERROR"|"DATA_VALIDATION_ERROR"|"UNKNOWN_ERROR","retrieved_data":array|null,"error_details":string|null}.';
  assert.deepEqual(L.errorStatuses(webarena), [
    "ACTION_NOT_ALLOWED_ERROR",
    "PERMISSION_DENIED_ERROR",
    "NOT_FOUND_ERROR",
    "DATA_VALIDATION_ERROR",
    "UNKNOWN_ERROR",
  ]);
  assert.deepEqual(
    L.errorStatuses('Return exactly one JSON object {"status": "pass" | "fail" | "not_found", "count": number}.'),
    ["fail", "not_found"],
  );
  assert.deepEqual(L.errorStatuses("Answer as one JSON object"), []); // no format spelled out
  assert.deepEqual(L.errorStatuses('Return exactly one JSON object {"name": string, "error": string}.'), []); // no status field
  assert.deepEqual(L.errorStatuses("Did the save fail? Answer yes or no."), []);
});

// test_last_mutating_step
test("lastMutatingStep: the plan's last browse or fill step that changes something, if a change was confirmed for it", () => {
  const plan = {
    steps: [
      { kind: "browse", goal: "Add the bars to the cart" },
      { kind: "fill", goal: "Fill the shipping form", done_when: "the shipping address is saved" },
      { kind: "collect", goal: "List the orders" },
      { goal: "Save the rule" }, // no kind: run as a browse step
      { kind: "read", goal: "Report the result", save_as: "final_task_answer" },
    ],
  };
  const at = (steps, ...goals) =>
    L.lastMutatingStep(
      { steps },
      goals.map((step) => ({ step })),
    );
  const all = plan.steps;
  assert.equal(at(all.slice(0, 1), "Add the bars to the cart"), 0);
  assert.equal(at(all.slice(0, 3), "Fill the shipping form", "Add the bars to the cart"), 1);
  assert.equal(at(all, "Add the bars to the cart", "Save the rule"), 3);
  assert.equal(at(all, "List the orders"), null); // a list's paging is not a change the task made
  assert.equal(at(all, "Report the result"), null);
  assert.equal(at(all, "A step a replan dropped"), null);
  assert.equal(at(all), null);
  // ruling 14: the plan's last mutating step decides, whether or not the run got to it: an add-to-cart confirmed
  // before an order that was never placed is not the task's last change
  assert.equal(at(all, "Add the bars to the cart"), null);
  const cart = { kind: "browse", goal: "Add the bars to the cart" };
  assert.equal(at([cart, { kind: "browse", goal: "Place the order" }], "Add the bars to the cart"), null);
  // a later step that changes nothing (opening a page) leaves the add-to-cart the last change
  assert.equal(at([cart, { kind: "browse", goal: "Open the order history page" }], "Add the bars to the cart"), 0);
});

// test_refusal_changes
test("refusalChanges: the last mutating step's confirmations, none after a rejection; a setting step's XHR POST is none", () => {
  const change = (step, extra = {}) => ({
    step,
    move: "clicked button 'Go'",
    requests: ["POST /x 200"],
    notices: [],
    rejected: false,
    ...extra,
  });
  const cite = (steps, changes) => L.refusalChanges({ steps }, changes);
  const save = { kind: "browse", goal: "Save the rule" };
  const saved = change(save.goal);
  assert.deepEqual(cite([save], [saved]), [saved]); // not a setting step: its XHR POST 200 confirms
  assert.deepEqual(cite([save], []), []);
  assert.deepEqual(cite([save], [saved, change(save.goal, { rejected: true })]), []); // rejected after it
  // ruling 15: a step that also sets something ("Apply the Legal filter") confirms only by a navigating form post or a
  // PUT, PATCH or DELETE (strong), or a success notice: the POST a single-page app's search sends is no change
  const filter = { kind: "browse", goal: "Apply the Legal filter" };
  const search = change(filter.goal, { requests: ["POST /api/search 200"] });
  assert.deepEqual(cite([filter], [search]), []);
  const posted = change(filter.goal, { strong: true });
  assert.deepEqual(cite([filter], [search, posted]), [posted]);
  const noticed = change(filter.goal, { notices: ["Filter saved"] });
  assert.deepEqual(cite([filter], [noticed]), [noticed]);
  const subscribe = { kind: "browse", goal: "Enter the email and subscribe" };
  const form = change(subscribe.goal, { requests: ["POST /newsletter/subscriber/new 302"], strong: true });
  assert.deepEqual(cite([subscribe], [form]), [form]);
  // the setting step's search POST is not "the change" a later rejection must come after, nor one that stands in for
  // the step: with only it, nothing is cited
  assert.deepEqual(cite([save, filter], [saved, search]), []);
});

// test_mutating_step_verbs
test("isMutatingStep: a step that changes something by its first word, or by its done_when after a navigation", () => {
  const mutating = (goal, done_when) => L.isMutatingStep({ goal, done_when });
  assert.equal(mutating("Save the rule"), true);
  assert.equal(mutating("Click Save"), true);
  assert.equal(mutating("Post a comment"), true);
  assert.equal(mutating("Click Upvote on the post"), true);
  assert.equal(mutating("Open the merge requests page"), false);
  assert.equal(mutating("Find the issue about the login bug"), false);
  assert.equal(mutating("Open the Reviews tab"), false);
  assert.equal(mutating("Sort by price"), false);
  assert.equal(mutating("Open the rule page", "the page says the rule was saved"), true);
  assert.equal(mutating("Open the issues page", "the issues list is shown"), false);
  // a leading "then", "now", "also" or "please" is skipped too; a verb inside a goal of no listed first word counts
  assert.equal(mutating("Then click Submit"), true);
  assert.equal(mutating("Proceed to checkout", ""), true);
  assert.equal(mutating("Check out"), true);
  assert.equal(mutating("Proceed to check out"), true);
  assert.equal(mutating("check out the cart"), true);
  assert.equal(mutating("Make sure the order history is shown"), false); // "order" counts only as a first word
  assert.equal(L.isMutatingStep({}), false);
});

// --- settingReadback: the values a setting step sets, as the page read-back looks for them --------------------------
// test_setting_step_verbs
test("isSettingStep: a browse or fill step whose goal or done_when sets something (sort, filter, select, type...)", () => {
  const setting = (goal, done_when, kind) => L.isSettingStep({ kind, goal, done_when });
  assert.equal(setting("Sort by price"), true);
  assert.equal(setting("Open the Reviews tab"), false);
  assert.equal(setting("Click See 12 Homes"), false);
  assert.equal(setting("Open the jobs page", "The Legal category filter is applied"), true);
  assert.equal(setting("Choose the Large size", "", "fill"), true);
  assert.equal(setting("Type the address into the search box"), true);
  assert.equal(setting("Narrow the results to 2 bedrooms"), true);
  assert.equal(setting("Open the settings page", "The Settings page is shown"), false); // "set" only as a word
  assert.equal(setting("Select the answer", "", "read"), false); // a read sets nothing on the page
  assert.equal(L.isSettingStep({}), false);
});

// test_literals_from_texts_quotes_numbers
test("settingLiterals: the step's texts, its quoted values and its numbers with a unit or currency", () => {
  const step = {
    kind: "browse",
    goal: 'Filter the jobs by category "Legal" and set the max salary to $25 an hour',
    done_when:
      "The results show 12 pairs at 4,000 or less, sorted by \u201cPrice ascending\u201d; the size is 'Medium'",
    texts: [{ name: "query", text: "wool socks" }],
  };
  assert.deepEqual(L.settingLiterals(step, [], "Find wool socks"), [
    "wool socks",
    "Legal",
    "Price ascending",
    "Medium",
    "$25",
    "12 pairs",
  ]);
  // a bare number, an ordinal and a number before a joining word are not values; a grouped one is, and a man's
  // apostrophe opens no quote
  const plain = { goal: "Select the 2nd option, 3 and 10 for men's shoes at 4,000 or 2 bedroom", done_when: "" };
  assert.deepEqual(L.settingLiterals(plain, [], ""), ["4,000", "2 bedroom"]);
  // a number inside a quoted value is that value, not a second one
  assert.deepEqual(L.settingLiterals({ goal: 'Choose "12 pairs pack"', done_when: "" }, [], ""), ["12 pairs pack"]);
  // a number before a word that is no unit or measure is no value: a count of results, a button's number
  assert.deepEqual(L.settingLiterals({ goal: "Select the top 3 results", done_when: "" }, [], ""), []);
  assert.deepEqual(L.settingLiterals({ goal: "Set the filters, then click See 12 Homes" }, [], ""), []);
  const units = { goal: "Choose 3 nights for 2 adults, a 2-bedroom unit, 4.5 stars and 50% off", done_when: "" };
  assert.deepEqual(L.settingLiterals(units, [], ""), ["3 nights", "2 adults", "2-bedroom", "4.5 stars", "50%"]);
});

// test_literals_exclude_clicked_control_names
test("settingLiterals: a value equal to a control clicked in the step was an action, not a value", () => {
  const step = { goal: 'Set 2 bedrooms and click "See 12 Homes"', done_when: "", texts: [] };
  assert.deepEqual(L.settingLiterals(step, [], ""), ["See 12 Homes", "2 bedrooms"]);
  assert.deepEqual(L.settingLiterals(step, ["See 12 homes"], ""), ["2 bedrooms"]);
  // the whole task quoted (a done_when that quotes the task) is not a value either
  const task = "Sort the Legal jobs by date";
  const quoting = { goal: task, done_when: `Does the screen show that the user's task is finished: "${task}"?` };
  assert.deepEqual(L.settingLiterals(quoting, [], task), []);
});

// test_literals_exclude_unresolved_notes
test("settingLiterals: a text or quote that still names a note ({{note1}}) is no value", () => {
  const step = {
    goal: 'Type "{{note1}}" into the search box',
    done_when: "",
    texts: [
      { name: "q", text: "{{note1}}" },
      { name: "city", text: "Seattle {{ note2 }}" },
      { name: "name", text: "Jane Doe" },
    ],
  };
  assert.deepEqual(L.settingLiterals(step, [], ""), ["Jane Doe"]);
});

// test_literal_cap_six
test("settingLiterals: at most six values a step, texts first, and none twice once normalised", () => {
  const texts = ["A1", "B2", "C3", "D4", "E5"].map((text, i) => ({ name: `t${i}`, text }));
  const step = { goal: 'Pick "full time", "Full-time", "Remote" and "Hybrid"', done_when: "", texts };
  assert.deepEqual(L.settingLiterals(step, [], ""), ["A1", "B2", "C3", "D4", "E5", "full time"]);
  assert.equal(L.settingLiterals({ goal: 'Pick "a", "b", "c", "d", "e", "f", "g", "h"' }, [], "").length, 6);
});

// test_normalize_literal
test("normalizeLiteral: case, punctuation, & and spacing do not make two values differ", () => {
  assert.equal(L.normalizeLiteral("Full-time"), L.normalizeLiteral("full time"));
  assert.equal(L.normalizeLiteral("Full-time"), "full time");
  assert.equal(L.normalizeLiteral("Cabinets, Racks & Shelves"), "cabinets racks and shelves");
  assert.equal(L.normalizeLiteral("  Price:  Low\tto High "), "price low to high");
  assert.equal(L.normalizeLiteral("price_asc"), "price asc");
  assert.equal(L.normalizeLiteral("$25"), "25");
  assert.equal(L.normalizeLiteral("Café"), "café");
});

// revealEvidence: what the end of a run looks for on the page
test("revealLiterals: the final read's quoted values, numbers with a unit or currency and tokens, before the answer's", () => {
  const evidence = "Today's Conditions shows 'Wind 13 km/h S'. The FAQ agrees.";
  const answer = "Current wind speed in Calgary is 13 km/h from the south, with gusts up to 20 km/h.";
  // the evidence's own facts only: the answer's gusts ("20 km") are not looked for while the evidence names something
  assert.deepEqual(L.revealLiterals(evidence, answer), ["Wind 13 km/h S", "13 km/h", "13 km"]);
  // a currency amount and a notice the read quoted; none twice once normalised
  assert.deepEqual(
    L.revealLiterals('The info notice says "Availability is not yet released. Check back on January 10, 2027"', ""),
    ["Availability is not yet released. Check back on January 10, 2027"],
  );
  assert.deepEqual(L.revealLiterals("Without Auto Pay the total is $180/mo ($180 shown)", ""), ["$180"]);
  // evidence naming nothing to look for: the answer's tokens, as before
  assert.deepEqual(L.revealLiterals("The cart shows the item", "Added it for $169.95."), ["$169.95"]);
  assert.deepEqual(L.revealLiterals(undefined, "The dose is 380 mg."), ["380 mg"]);
  // capitalised names are no literals: they are on screen already and would only stop the scroll
  assert.deepEqual(L.revealLiterals("The Boston Soft Footbed Suede Leather is in the Data Center Driver list", ""), []);
  assert.ok(L.revealLiterals(`"a1" "b2" "c3" "d4" "e5" "f6" "g7" "h8" "i9" "j10"`, "").length <= L.MAX_REVEAL_LITERALS);
});

// test_literals_quotes_word_boundaries_short_values
test("settingLiterals: an apostrophe inside a word opens no quote; a literal is a short value, not a sentence", () => {
  const lit = (goal, done_when = "") => L.settingLiterals({ kind: "browse", goal, done_when, texts: [] }, [], "");
  const step = {
    kind: "browse",
    goal: "From the One Stop Market home page, use the site's category menu to open the Cabinets, Racks & Shelves category page and stop once that category listing is on screen.",
    texts: [],
    done_when: "The Cabinets, Racks & Shelves category page is open and visible on screen.",
    rules: "Use only the site's own navigation menu or category links. Close any pop-ups. Do not use a search engine.",
  };
  assert.deepEqual(L.settingLiterals(step, [], "Open the category"), []);
  // two apostrophes in words, and an agent move log quoted in a replan's goal, are no values
  assert.deepEqual(lit("Use the site's menu; the shop's 'pointed at menuitem' note and Don't stop"), []);
  assert.deepEqual(lit("Open the 'Legal' category"), ["Legal"]);
  assert.deepEqual(lit("Type 'San Diego County' into the location box"), ["San Diego County"]);
  assert.deepEqual(lit("Use the site's menu to pick 'Women's Shoes'"), ["Women's Shoes"]);
  assert.deepEqual(lit("Pick 'one two three four five six seven eight nine ten eleven twelve' now"), []);
  assert.deepEqual(lit('Pick "Price ascending" and "It is done. Next step"'), ["Price ascending"]);
  assert.deepEqual(lit('Select "Medium" in the size list'), ["Medium"]);
  // the instruction itself in quotes is dropped (a slice of four words or more that is most of its sentence)
  assert.deepEqual(lit("Select 'the cheapest of all the options'", ""), []);
});

test("test_drag_option_only_for_draggable: a drag move for each draggable element, only with the dragTo flag and a drag hint", () => {
  const els = [el("E1", "button 's'", { draggable: true, node: 1 }), el("E2", "button 'L'", { node: 2 })];
  const on = L.buildOptions({ els, dragTo: true, dragHint: true });
  const off = L.buildOptions({ els, dragTo: false, dragHint: true });
  const drags = (o) => Object.keys(o.acts).filter((k) => o.acts[k].kind === "drag_pick");
  assert.deepEqual(drags(on), ["drag E1"]);
  assert.equal(on.acts["drag E1"].el, els[0]);
  assert.match(on.opts["drag E1"], /button 's'/);
  // the flag adds that one move and nothing else; off, nothing changes
  assert.deepEqual(
    Object.keys(on.opts).filter((k) => !(k in off.opts)),
    ["drag E1"],
  );
  assert.deepEqual(drags(off), []);
  assert.deepEqual(Object.keys(off.opts), Object.keys(L.buildOptions({ els }).opts));
  // no drag, drop, move or sort word in the step or task (a board whose library marks every card draggable): the
  // switch alone offers nothing, and nothing else changes
  const noHint = L.buildOptions({ els, dragTo: true });
  assert.deepEqual(drags(noHint), []);
  assert.deepEqual(Object.keys(noHint.opts), Object.keys(L.buildOptions({ els }).opts));
  assert.deepEqual(drags(L.buildOptions({ els, dragTo: true, dragHint: false })), []);
  // a draggable element alone on screen has nothing to be dropped onto
  assert.deepEqual(drags(L.buildOptions({ els: [els[0]], dragTo: true, dragHint: true })), []);
  // nor has one whose only company is a canvas or a picture, which are no drop targets (L.dropTargets)
  const canvas = el("E3", "canvas (no label)", { role: "canvas", node: 3 }),
    picture = el("E4", "img 'Reward'", { role: "img", node: 4 });
  assert.deepEqual(drags(L.buildOptions({ els: [els[0], canvas, picture], dragTo: true, dragHint: true })), []);
  assert.deepEqual(drags(L.buildOptions({ els: [els[0], canvas, els[1]], dragTo: true, dragHint: true })), ["drag E1"]);
});

test("test_whatof_drag_to: a drag names the element dragged and the one it was dropped onto", () => {
  const from = el("E3", "button 's'", { node: 3 }),
    to = el("E7", "button 'L'", { node: 7 });
  assert.equal(L.whatOf({ kind: "drag_to", el: from, to }), "dragged E3 (button 's') onto E7 (button 'L')");
  assert.match(L.whatOf({ kind: "drag_pick", el: from }), /^drag E3 \(button 's'\)/);
});

test("test_action_identity_includes_target: the same element dragged onto another target is another action", () => {
  const from = el("E3", "button 's'", { node: 3 });
  const onto = (node) => ({ kind: "drag_to", el: from, to: el(`E${node}`, "button 'L'", { node }) });
  assert.notEqual(L.actionIdentity(onto(7), undefined), L.actionIdentity(onto(8), undefined));
  assert.equal(L.actionIdentity(onto(7), undefined), L.actionIdentity(onto(7), undefined));
});

test("test_drag_to_risky_unless_slider: a drag between elements asks like a drag gesture, but not from a slider", () => {
  const to = el("E2", "button 'L'", { node: 2 });
  assert.equal(L.isRiskyGesture({ kind: "drag_to", el: el("E1", "button 's'", { node: 1 }), to }), true);
  const slider = el("E1", "slider 'Price'", { node: 1, role: "slider", name: "Price" });
  assert.equal(L.isRiskyGesture({ kind: "drag_to", el: slider, to }), false);
  // a slide-to-act widget's drag is the act itself
  const pay = el("E1", "slider 'Slide to pay'", { node: 1, role: "slider", name: "Slide to pay" });
  assert.equal(L.isRiskyGesture({ kind: "drag_to", el: pay, to }), true);
});

// MiniWoB choose-date (round 6): the date field is read-only and opens a jQuery UI calendar; Drex clicked "Prev" over
// and over and the LLM typed into the field. datePicker: the field gets a move that sets it to a date, in one move.
test("test_parse_date_forms: ISO, US m/d/yyyy, d Month yyyy and Month d, yyyy; anything else is no date", () => {
  const date = (y, m, d) => ({ y, m, d });
  assert.deepEqual(L.parseDate("2016-04-08"), date(2016, 4, 8));
  assert.deepEqual(L.parseDate("04/08/2016"), date(2016, 4, 8)); // month first, as MiniWoB writes it
  assert.deepEqual(L.parseDate("4/8/2016"), date(2016, 4, 8));
  assert.deepEqual(L.parseDate("8 April 2016"), date(2016, 4, 8));
  assert.deepEqual(L.parseDate("8 Apr 2016"), date(2016, 4, 8));
  assert.deepEqual(L.parseDate("April 8, 2016"), date(2016, 4, 8));
  assert.deepEqual(L.parseDate("Dec 3, 2016"), date(2016, 12, 3));
  assert.deepEqual(L.parseDate("  september 30 2016 "), date(2016, 9, 30));
  assert.deepEqual(L.parseDate("12/03/2016."), date(2016, 12, 3));
  for (const no of [
    "",
    "Boston",
    "04/08",
    "2016",
    "13/08/2016",
    "02/30/2016",
    "Select 04/08/2016 as the date",
    "8 Smarch 2016",
  ])
    assert.equal(L.parseDate(no), null, no);
});

test("test_step_date_from_texts_then_goal_then_task: a date text first, then the one date the goal, done_when or task names", () => {
  const task = "Select 04/08/2016 as the date and hit submit.";
  // a text that is a date wins (the first one)
  const texts = [
    { name: "city", text: "Boston" },
    { name: "when", text: "April 9, 2016" },
    { name: "back", text: "2016-04-10" },
  ];
  assert.equal(L.stepDate({ goal: "Pick 04/08/2016", texts }, task), "April 9, 2016");
  // no text is a date: the goal's date, then done_when's, then the task's
  assert.equal(
    L.stepDate({ goal: "Set the date to 05/01/2016", done_when: "it shows 2016-06-01", texts: [] }, task),
    "05/01/2016",
  );
  assert.equal(L.stepDate({ goal: "Set the date", done_when: "the field shows 2016-06-01" }, task), "2016-06-01");
  assert.equal(L.stepDate({ goal: "Set the date", done_when: "the field shows it" }, task), "04/08/2016");
  assert.equal(L.stepDate({}, "Book the cheapest one-way flight from: Boston to: Nome on 12/03/2016."), "12/03/2016");
  // the same date twice (or in two forms) is one date
  assert.equal(L.stepDate({ goal: "Select 04/08/2016, then check it reads 04/08/2016" }, ""), "04/08/2016");
  assert.equal(L.stepDate({ goal: "Pick April 8, 2016 (04/08/2016)" }, ""), "April 8, 2016");
});

test("test_step_date_ambiguous_is_null: two different dates, or none, give no date", () => {
  assert.equal(L.stepDate({ goal: "Fly out 12/03/2016 and back 12/10/2016" }, "Select 12/03/2016"), null);
  assert.equal(L.stepDate({ goal: "Set the dates" }, "Depart on 12/03/2016, return on December 10, 2016"), null);
  assert.equal(L.stepDate({ goal: "Click submit", texts: [{ name: "q", text: "Boston" }] }, "Book a flight"), null);
  assert.equal(L.stepDate({ goal: "Select 02/30/2016" }, ""), null); // no such day
});

test("test_readonly_field_gets_type_option_for_date: a read-only field gets a move per date text, only with the flag", () => {
  const ro = el("E1", "textbox (no label)", {
    node: 1,
    role: "textbox",
    state: " (read-only: click it to open what sets it)",
    readOnly: true,
  });
  const box = el("E2", "textbox 'From:'", { node: 2, role: "textbox", field: true });
  const texts = [
    { name: "date", text: "04/08/2016" },
    { name: "city", text: "Boston" },
  ];
  const on = L.buildOptions({ els: [ro, box], texts, datePicker: true });
  assert.deepEqual(on.acts["type date into E1"], { kind: "type", el: ro, text: texts[0] });
  assert.match(on.opts["type date into E1"], /'04\/08\/2016'/);
  assert.equal(on.acts["type city into E1"], undefined); // not a date: no move on the read-only field
  assert.equal(on.acts["click E1"].kind, "click"); // still clickable
  // off (the default), the read-only field only gets its click, as before
  const off = L.buildOptions({ els: [ro, box], texts, datePicker: false });
  assert.deepEqual(Object.keys(L.buildOptions({ els: [ro, box], texts }).opts), Object.keys(off.opts));
  assert.deepEqual(
    Object.keys(on.opts).filter((k) => !(k in off.opts)),
    ["type date into E1"],
  );
  // the date a step names (no text of it is a date): offered on the read-only field only, not at the cursor or elsewhere
  const named = [{ name: "date", text: "04/08/2016" }];
  const fromStep = L.buildOptions({ els: [ro, box], texts: [texts[1]], datePicker: true, dateTexts: named });
  assert.deepEqual(fromStep.acts["type date into E1"], { kind: "type", el: ro, text: named[0] });
  assert.equal(fromStep.acts["type date into E2"], undefined);
  assert.equal(fromStep.acts["type date at the cursor"], undefined);
  assert.equal(L.buildOptions({ els: [ro, box], dateTexts: named }).acts["type date into E1"], undefined);
  // only a read-only text box or combobox is a date field (a read-only combobox input is listed as a "dropdown"); a
  // read-only checkbox or grid, or a select, is not
  const ro2 = (role, extra = {}) => el("E5", `${role} 'When'`, { node: 5, role, readOnly: true, ...extra });
  for (const [e, offered] of [
    [ro2("combobox"), true],
    [ro2("dropdown"), true],
    [ro2("checkbox"), false],
    [ro2("grid"), false],
    [ro2("dropdown", { select: true, options: [] }), false],
  ]) {
    const got = L.buildOptions({ els: [e], texts: [texts[0]], datePicker: true, dateTexts: named });
    assert.equal(got.acts["type date into E5"] !== undefined, offered, e.role + (e.select ? " select" : ""));
    assert.equal(L.datePickerField(e), offered);
  }
  // the move in the history: the field set to the date, in one move
  assert.equal(L.whatOf(on.acts["type date into E1"], "04/08/2016"), "set E1 to 04/08/2016");
  assert.equal(L.whatOf({ kind: "type", el: box }, "Boston"), "typed 'Boston' into textbox 'From:'");
});

test("test_copy_option_only_with_hint_and_flag: one 'copy the text of E#' per eligible source, only with copyMove and copyHint, and only when another editable field is on screen", () => {
  const els = [
    el("E1", "textbox 'Answer'", { role: "textbox", name: "Answer", field: true, node: 1 }),
    el("E2", "textbox 'Notes'", { role: "textbox", name: "Notes", textarea: true, field: true, node: 2 }),
    el("E3", "paragraph 'Lorem ipsum'", { role: "paragraph", name: "Lorem ipsum", ownText: true, node: 3 }),
    el("E4", "heading ''", { role: "heading", name: "", node: 4 }), // no text of its own: not a source
    el("E6", "checkbox 'Agree'", { role: "checkbox", name: "Agree", node: 6 }), // named, no text of its own
    el("E7", "combobox 'Size'", { role: "combobox", name: "Size", select: true, ownText: true, node: 7 }),
    el("E8", "button 'Close'", { role: "button", name: "Close", node: 8 }), // an icon button named by aria-label
    el("E5", "textbox 'Date'", { role: "textbox", name: "Date", field: true, readOnly: true, node: 5 }),
  ];
  const copies = (o) => Object.keys(o.acts).filter((k) => o.acts[k].kind === "copy_pick");
  const on = L.buildOptions({ els, copyMove: true, copyHint: true });
  // the read-only box is a source too (its text can be copied) but is never a place to paste
  assert.deepEqual(copies(on), [
    "copy the text of E1",
    "copy the text of E2",
    "copy the text of E3",
    "copy the text of E5",
  ]);
  assert.equal(on.acts["copy the text of E3"].el, els[2]);
  assert.match(on.opts["copy the text of E3"], /paragraph 'Lorem ipsum'/);
  assert.deepEqual(copies(L.buildOptions({ els, copyMove: true })), []); // no copy/paste word in the step
  assert.deepEqual(copies(L.buildOptions({ els, copyHint: true })), []); // switch off
  assert.deepEqual(copies(L.buildOptions({ els })), []);
  assert.deepEqual(
    Object.keys(L.buildOptions({ els, copyMove: true }).opts),
    Object.keys(L.buildOptions({ els }).opts),
  );
  // a lone editable field has nothing to be pasted into but itself
  assert.deepEqual(copies(L.buildOptions({ els: [els[0]], copyMove: true, copyHint: true })), []);
  // a read-only box is no place to paste: its text can go into the editable one, not the other way round
  assert.deepEqual(
    copies(L.buildOptions({ els: [els[0], els.find((e) => e.label === "E5")], copyMove: true, copyHint: true })),
    ["copy the text of E5"],
  );
});

test("test_whatof_copy_to: a copy names the element copied and the field it went into", () => {
  const from = el("E3", "paragraph 'Lorem'", { node: 3 }),
    to = el("E7", "textbox 'Answer'", { node: 7 });
  assert.equal(L.whatOf({ kind: "copy_pick", el: from }), "copy the text of E3 (paragraph 'Lorem')");
  assert.equal(L.whatOf({ kind: "copy_to", el: from, to }), "copied E3 (paragraph 'Lorem') into E7 (textbox 'Answer')");
  const id = (t) => L.actionIdentity({ kind: "copy_to", el: from, to: t }, undefined);
  assert.notEqual(id(to), id(el("E8", "textbox 'Answer'", { node: 8 }))); // another field is another move
});

// MiniWoB drag-items-grid's list: nine sortable items of one parent (BOX_FN's group), each named differently, so the
// scan's repeated-control grid (e.grid) never labels them; 3 rows of 3, 44 px apart
const listCells = () =>
  ["Ann", "Bo", "Cy", "Di", "Ed", "Flo", "Gus", "Hal", "Ivy"].map((name, i) => {
    const x = 10 + (i % 3) * 44,
      y = 60 + Math.floor(i / 3) * 44;
    return el(`E${i + 2}`, `button '${name}'`, { role: "button", name, group: "p:4", box: [x, y, x + 38, y + 38] });
  });

test("test_drop_targets_no_canvas_image_or_source: every other element on screen, but no canvas, picture or boxless one", () => {
  const cells = listCells();
  const els = [
    el("E1", "canvas (no label)", { role: "canvas", box: [200, 0, 360, 210] }),
    ...cells,
    el("E11", "img 'Logo'", { role: "img" }),
    el("E12", "button 'Gone'", { role: "button", box: undefined }),
    el("E13", "button 'Submit'", { role: "button", group: "p:9", box: [10, 200, 60, 220] }),
  ];
  const source = cells[7];
  assert.deepEqual(
    L.dropTargets(els, source).map((e) => e.label),
    ["E2", "E3", "E4", "E5", "E6", "E7", "E8", "E10", "E13"],
  );
});

test("test_drop_target_description_grid_cells: a sibling of the dragged element is named by its cell; the odd grid's middle is the centre", () => {
  const cells = listCells();
  const submit = el("E13", "button 'Submit'", { role: "button", group: "p:9", box: [10, 200, 60, 220] });
  const els = [...cells, submit];
  const source = cells[7]; // Hal: bottom row, middle column
  assert.equal(
    L.dropTargetDescription(source, cells[4], els),
    "row 2, column 2 of a 3×3 grid (the centre): button 'Ed'",
  );
  assert.equal(L.dropTargetDescription(source, cells[0], els), "row 1, column 1 of a 3×3 grid: button 'Ann'");
  assert.equal(L.dropTargetDescription(source, cells[8], els), "row 3, column 3 of a 3×3 grid: button 'Ivy'");
  // not in the dragged element's grid: its direction and distance from the dragged element's centre (73,167)
  assert.equal(L.dropTargetDescription(source, submit, els), "below, 43 px: button 'Submit'");
  assert.equal(
    L.dropInstructions(source, els),
    "Drop it onto which element? The element you drag is at row 3, column 2 of a 3×3 grid. Each option starts with where that element is: its cell in that grid, or its direction and distance from the element you drag.",
  );
  assert.match(L.dropInstructions(cells[4], els), /is at row 2, column 2 of a 3×3 grid \(the centre\)\./);
  // an even grid has no middle cell
  const four = listCells()
    .slice(0, 4)
    .map((e, i) => ({
      ...e,
      box: [i % 2 ? 54 : 10, i < 2 ? 60 : 104, (i % 2 ? 54 : 10) + 38, (i < 2 ? 60 : 104) + 38],
    }));
  assert.equal(L.dropTargetDescription(four[0], four[3], four), "row 2, column 2 of a 2×2 grid: button 'Di'");
});

test("test_drop_target_description_scan_grid: elements the scan placed in its repeated-control grid (e.grid) keep that cell", () => {
  const tiles = Array.from({ length: 9 }, (_, i) => {
    const row = Math.floor(i / 3) + 1,
      column = (i % 3) + 1,
      x = column * 50,
      y = row * 50;
    // each tile in a wrapper of its own: no shared parent group
    return el(`E${i + 1}`, "button 'Tile'", {
      role: "button",
      name: "Tile",
      group: `p:${i + 1}`,
      box: [x, y, x + 40, y + 40],
      grid: { row, column, ordinal: i + 1, total: 9 },
    });
  });
  assert.equal(
    L.dropTargetDescription(tiles[0], tiles[4], tiles),
    "row 2, column 2 of a 3×3 grid (the centre): button 'Tile'",
  );
  assert.equal(L.dropTargetDescription(tiles[0], tiles[5], tiles), "row 2, column 3 of a 3×3 grid: button 'Tile'");
  // a cell of the grid is off screen: the cells keep their row and column, with no size or centre to go by
  const seen = tiles.slice(0, 8);
  assert.equal(L.dropTargetDescription(seen[0], seen[4], seen), "row 2, column 2: button 'Tile'");
});

test("test_drop_target_description_direction: with no shared grid, the dominant direction and distance between centres", () => {
  const at = (label, name, x, y, extra = {}) =>
    el(label, `button '${name}'`, { role: "button", name, box: [x, y, x + 10, y + 10], ...extra });
  const source = at("E2", "s", 20, 0);
  const els = [
    at("E1", "Submit", 0, 0),
    source,
    at("E3", "L", 140, 30),
    at("E4", "Up", 25, -40),
    at("E5", "Same", 20, 0),
  ];
  assert.equal(L.dropTargetDescription(source, els[0], els), "to the left, 20 px: button 'Submit'");
  assert.equal(L.dropTargetDescription(source, els[2], els), "to the right, 120 px: button 'L'");
  assert.equal(L.dropTargetDescription(source, els[3], els), "above, 40 px: button 'Up'");
  assert.equal(L.dropTargetDescription(source, els[4], els), "at the same place: button 'Same'");
  assert.equal(
    L.dropInstructions(source, els),
    "Drop it onto which element? The element you drag is centred at x 25, y 5 on screen. Each option starts with that element's direction and distance from the element you drag.",
  );
  // siblings that form no regular grid (a row of three over one) are placed by direction too
  const ragged = [at("E1", "a", 0, 0), at("E2", "b", 44, 0), at("E3", "c", 88, 0), at("E4", "d", 0, 44)].map((e) => ({
    ...e,
    group: "p:1",
  }));
  assert.equal(L.dropTargetDescription(ragged[0], ragged[3], ragged), "below, 44 px: button 'd'");
  // two siblings are a pair, not a grid
  assert.equal(L.dropTargetDescription(ragged[0], ragged[1], ragged.slice(0, 2)), "to the right, 44 px: button 'b'");
});

// test_chosen_value_and_literals
test("chosenValue: what a move sets; chosenLiterals: the step's values a move set, as whole words either way", () => {
  const el = (role, name) => ({ role, name, text: `${role} '${name}'` });
  assert.equal(L.chosenValue({ kind: "type", el: el("textbox", "City") }, "Atlanta"), "Atlanta");
  assert.equal(
    L.chosenValue({ kind: "select", el: el("combobox", "Sort"), index: 2, value: "Newest" }, null),
    "Newest",
  );
  assert.equal(L.chosenValue({ kind: "click", el: el("checkbox", "Remote (12)") }, null), "Remote (12)");
  assert.equal(L.chosenValue({ kind: "click", el: el("button", "See 12 Homes") }, null), ""); // an action, not a value
  assert.equal(L.chosenValue({ kind: "scroll", down: true }, null), "");
  assert.deepEqual(L.chosenLiterals(["Remote", "Legal", "2 adults"], ["Remote (12)", "2"]), ["Remote", "2 adults"]);
  assert.deepEqual(L.chosenLiterals(["Legal"], []), []);
  assert.deepEqual(L.chosenLiterals(["Rem"], ["Remote"]), []); // part of a word is not the value
});
