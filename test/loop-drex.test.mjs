// The tools Drex carries out in the loop: do, click, type, pick and check. The agent is the real LoopAgent; the tab,
// look, drexCall and act are fakes, so these tests are about how the loop asks Drex, when it hands the move back, and
// what the LLM is told afterwards. act's own work (checks, approvals, the move itself) has its own tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { MOVE_Q, buildOptions, whatOf } from "../src/logic.ts";
import { SHORT_VIEW, controlId, controlLine, pageView } from "../src/loop/view.ts";

// The loop agent as the worker bundles it. The cost switches are build-time, so a test that needs one gets its own.
async function bundle(define = {}) {
  const dir = await mkdtemp(join(tmpdir(), "drex-loop-drex-"));
  try {
    await build({
      entryPoints: [join(resolve("src"), "loop", "agent.ts")],
      outdir: dir,
      bundle: true,
      platform: "node",
      format: "esm",
      packages: "external",
      define,
    });
    return await import(pathToFileURL(join(dir, "agent.js")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
const { LoopAgent, DO_MAX_MOVES, DO_MAX_TEXTS, HANDBACK_P, RISKY_P } = await bundle();
const textOnly = await bundle({ __DREX_COST__: '"drexText,searchEnter"' });
const switched = await bundle({ __DREX_ACC__: '"dragTo,copyMove,datePicker"' });
const compact = await bundle({ __DREX_COST__: '"drexCompact"' });

const START = "https://shop.example/orders";
const PAGE_TEXT = "Order list\nTotal 42";
const IMG1 = "data:image/webp;base64,SU1BR0Ux";
const IMG2 = "data:image/webp;base64,SU1BR0Uy";
const TASK = "Find the total of the orders";
const DREX_FIRST =
  "Use do for page actions: Drex carries them out. click and type are only for an action Drex handed back.";

const control = (label, role, name, more = {}) => ({
  label,
  role,
  name,
  text: `${role} '${name}'`,
  node: Number(label.slice(1)),
  box: [0, 0, 10, 10],
  ...more,
});
const ELS = [
  control("E1", "textbox", "Search", { field: true }),
  control("E2", "link", "Orders"),
  control("E3", "button", "Apply"),
  control("E4", "textbox", "Quantity", { field: true }),
  control("E5", "combobox", "Status", { select: true, options: ["Open", "Complete"], selectedIndex: 0 }),
];
const OFF = [control("D1", "link", "Reports", { dist: 1, where: "1 screen down" })];
// the page as the agent hands it to the LLM: between page-data markers with the id of the run, which setup() fixes
const NONCE = "0a1b2c3d";
const fenced = (text) => `<page-data id="${NONCE}">\n${text}\n</page-data id="${NONCE}">`;
const view = (els = ELS, off = OFF) =>
  fenced(pageView({ title: "Orders", url: START, text: PAGE_TEXT }, els, off, SHORT_VIEW));
const VIEWPORT = { w: 800, h: 600 };

// What a view of the page lists under each tag: the controls its limits show.
const listed = (els, off) =>
  new Map(
    [...els.slice(0, SHORT_VIEW.controls), ...off.slice(0, SHORT_VIEW.off)].map((el) => [
      el.label,
      { ...controlId(el), node: el.node },
    ]),
  );

// A page that takes keys and settles; its elements are what the tools read. A test moves the page on by changing
// tab.els and tab.off; tab.reads counts how often the page was read.
function fakeTab({ els = ELS, off = OFF } = {}) {
  const tab = {
    id: 1,
    els,
    off,
    reads: 0,
    keys: [],
    settles: 0,
    info: async (limit = 6000) => ({
      title: "Orders",
      url: START,
      text: PAGE_TEXT.slice(0, limit),
      truncated: false,
      chars: PAGE_TEXT.length,
    }),
    elements: async () => {
      tab.reads++;
      return { els: tab.els, off: tab.off, vp: VIEWPORT };
    },
    key: async (name) => {
      tab.keys.push(name);
    },
    settle: async () => {
      tab.settles++;
    },
  };
  return tab;
}

// Drex's answer to a move: the choice with its probability, the others' probabilities, and the done question's.
const says = (choice, p, done, others = {}) => ({
  answers: { move: { choice, probabilities: { [choice]: p, ...others } }, done: { noul: done } },
  usage: { input_tokens: 1000 },
  ms: 12,
  usd: 0.00006,
});
// Drex's answers to the questions of a call, a choice for each: choose(question's instructions, its name).
const decides = (choose) => (call) => ({
  answers: Object.fromEntries(
    Object.entries(call.questions).map(([name, q]) => {
      const choice = choose(q.instructions, name);
      const probabilities = Object.fromEntries(Object.keys(q.criteria ?? { [choice]: 1 }).map((k) => [k, 0.05]));
      return [name, { choice, probabilities: { ...probabilities, [choice]: 0.9 } }];
    }),
  ),
  usage: { input_tokens: 800 },
  ms: 30,
  usd: 0.0002,
});

// drex: an array of replies (the last one repeats) or a function (call, n) -> reply. moved: what act's history entry
// holds besides the move's name. outcome: what act returns. handedBack: whether a do has handed back, which is what lets
// the LLM click and type itself (the tests of those tools need it; the tests of that rule say false). seen: whether the LLM
// has read the page it acts on, which a tag needs (a tag the last view did not list is not acted on).
function setup({
  drex = [],
  moved = {},
  outcome = { dispatched: true },
  els = ELS,
  off = OFF,
  Kind = LoopAgent,
  options = {},
  handedBack = true,
  seen = true,
} = {}) {
  const events = [];
  const agent = new Kind({
    drex: {},
    llm: {},
    emit: (type, data) => events.push({ type, ...data }),
    windowId: 1,
    ...options,
  });
  const tab = fakeTab({ els, off });
  const screen = {
    els,
    off,
    info: { title: "Orders", url: START },
    img1: IMG1,
    img2: IMG2,
    jpeg: "anBlZw==",
    thumb: "thumb",
  };
  agent.task = TASK;
  agent.nonce = NONCE;
  agent.handedBack = handedBack;
  if (seen) {
    agent.viewLabels = listed(els, off);
    agent.viewTabId = tab.id;
  }
  agent.t0 = performance.now();
  agent.notes = {};
  agent.index = 0;
  agent.plan = {
    summary: "",
    answer_from: "",
    direct: false,
    steps: [
      {
        kind: "browse",
        goal: "",
        open_url: "",
        use_tab: -1,
        done_when: "",
        rules: "",
        max_moves: 0,
        question: "",
        choices: [],
        texts: [],
        save_as: "",
      },
    ],
  };
  agent.currentTab = async () => tab;
  // reused: for each look, whether it took the capture that a move had left behind. look takes the page as Agent.look
  // does: that capture stands for the screen now and the page is not read again; else the page is read. The image work,
  // which needs a browser, is left out.
  const looks = { n: 0, reused: [] };
  agent.look = async (t) => {
    looks.n++;
    const reuse = agent.afterShot?.tabId === t.id ? agent.afterShot : null;
    looks.reused.push(reuse !== null);
    agent.afterShot = null;
    const read = reuse?.elements ?? (await t.elements());
    screen.els = read.els;
    screen.off = read.off;
    return screen;
  };
  const drexCalls = [];
  agent.drexCall = async (state, questions, images) => {
    const call = { state, questions, images };
    drexCalls.push(call);
    if (typeof drex === "function") return drex(call, drexCalls.length - 1);
    const reply = drex[Math.min(drexCalls.length - 1, drex.length - 1)];
    if (!reply) throw new Error("the script ran out");
    return reply;
  };
  const acts = [];
  agent.act = async (t, act, text, scr, history, who, p, note, opts) => {
    acts.push({ tab: t, act, text, scr, history, who, p, note, opts });
    history.push({ what: whatOf(act, text), changed: true, ...moved });
    return outcome;
  };
  return { agent, tab, screen, events, drexCalls, acts, looks };
}

test("the limits are the agreed values", () => {
  assert.equal(DO_MAX_MOVES, 6);
  assert.equal(HANDBACK_P, 0.2);
  assert.equal(RISKY_P, 0.5);
});

test("do: Drex clicks, then its screen check says the intent is done: one move, and the report says done", async () => {
  const t = setup({ drex: [says("click E2", 0.9, 0.1), says("click E2", 0.9, 0.95)] });
  const result = await t.agent.doIntent("open the orders page", "the order list is open", "");
  assert.equal(t.acts.length, 1);
  assert.equal(t.acts[0].act.kind, "click");
  assert.equal(t.acts[0].act.el.label, "E2");
  assert.equal(t.agent.totals.drexMoves, 1);
  assert.equal(
    result,
    [
      "DREX done (95% sure: the order list is open)",
      fenced("MOVES:\n1. clicked link 'Orders' -> the screen changed"),
      "PAGE NOW:",
      view(),
    ].join("\n"),
  );
  // the moves are page data: the text between the run's first markers is the MOVES block, and the DREX line is not in it
  const between = result.slice(
    result.indexOf(`<page-data id="${NONCE}">`),
    result.indexOf(`</page-data id="${NONCE}">`),
  );
  assert.equal(between, `<page-data id="${NONCE}">\nMOVES:\n1. clicked link 'Orders' -> the screen changed\n`);
});

test("do: Drex is unsure (under HANDBACK_P): no move is made, the LLM gets the top three options", async () => {
  const t = setup({
    drex: [
      says("click E2", 0.15, 0.1, { "click E3": 0.12, "scroll down": 0.1, "press tab": 0.05, "ask for help": 0.02 }),
    ],
  });
  const result = await t.agent.doIntent("open the orders page", "the order list is open", "");
  assert.equal(t.acts.length, 0);
  assert.equal(t.agent.totals.drexMoves, 0);
  assert.match(result.split("\n")[0], /^DREX handed back: .*click E2 \(15%\), click E3 \(12%\), scroll down \(10%\)$/);
  assert.ok(!result.includes("press tab"));
  assert.ok(
    result.includes(`\n${fenced("MOVES: none")}\nPAGE NOW:\n<page-data id="${NONCE}">\nPAGE: "Orders"`),
    result,
  );
});

test("do: a probability just at HANDBACK_P is not doubt", async () => {
  const t = setup({ drex: [says("click E2", HANDBACK_P, 0.1), says("click E2", 0.9, 0.99)] });
  const result = await t.agent.doIntent("open it", "it is open", "");
  assert.equal(t.acts.length, 1);
  assert.match(result, /^DREX done/);
});

test("do: a choice of ask for help, ask user or look is handed back, with no move", async () => {
  for (const choice of ["ask for help", "ask user", "look"]) {
    const t = setup({ drex: [says(choice, 0.9, 0.1)] });
    const result = await t.agent.doIntent("open it", "it is open", "");
    assert.equal(t.acts.length, 0, choice);
    assert.equal(t.drexCalls.length, 1, choice);
    assert.match(result.split("\n")[0], new RegExp(`^DREX handed back: .*'${choice}'.*${choice} \\(90%\\)`), choice);
    assert.match(result, /\nMOVES: none\n/, choice);
  }
});

test("do: a choice that is not a move on this page is handed back", async () => {
  const t = setup({ drex: [says("click E99", 0.9, 0.1)] });
  const result = await t.agent.doIntent("open it", "it is open", "");
  assert.equal(t.acts.length, 0);
  assert.match(result.split("\n")[0], /^DREX handed back: .*'click E99'.*not a move on this page/);
});

test("do: 'step done' with a sure screen check ends the step as done, with no move", async () => {
  const t = setup({ drex: [says("step done", 0.9, 0.9)] });
  const result = await t.agent.doIntent("open it", "it is open", "");
  assert.equal(t.acts.length, 0);
  assert.ok(result.startsWith(`DREX done (90% sure: it is open)\n${fenced("MOVES: none")}\nPAGE NOW:\n`), result);
  assert.equal(t.agent.totals.drexMoves, 0);
});

test("do: a move that changed nothing, chosen again, is handed back instead of repeated", async () => {
  const t = setup({ drex: [says("click E2", 0.9, 0.1)], moved: { changed: false } });
  const result = await t.agent.doIntent("open it", "it is open", "");
  assert.equal(t.acts.length, 1);
  assert.equal(t.drexCalls.length, 2);
  assert.match(result.split("\n")[0], /^DREX handed back: .*repeat 'clicked link 'Orders''.*changed nothing earlier/);
  assert.ok(result.includes(`\n${fenced("MOVES:\n1. clicked link 'Orders' -> nothing changed")}\nPAGE NOW:\n`), result);
});

test("do: after a move that only pointed at something, Drex's screen check alone does not end the step", async () => {
  const replies = [says("click E2", 0.9, 0.1), says("click E3", 0.9, 0.95), says("step done", 0.9, 0.95)];
  const t = setup({ drex: () => replies.shift(), moved: { revealOnly: true } });
  const result = await t.agent.doIntent("open the submenu and pick an item", "the item is picked", "");
  assert.deepEqual(
    t.acts.map((a) => a.act.el.label),
    ["E2", "E3"],
  );
  assert.match(result, /^DREX done \(95% sure: the item is picked\)\n/);
});

test("do: a reply with no screen check is handed back, not counted as 0%", async () => {
  const t = setup({ drex: [says("click E2", 0.9, undefined)] });
  const result = await t.agent.doIntent("open it", "it is open", "");
  assert.equal(t.acts.length, 0);
  assert.equal(result.split("\n")[0], "DREX handed back: Drex gave no done check. Its top options: click E2 (90%)");
  assert.equal(t.events.find((e) => e.type === "decision").doneP, null); // the record does not say 0
});

test("do: 'step done' that the screen check does not back is handed back with that check's number", async () => {
  const t = setup({ drex: [says("step done", 0.9, 0.1)] });
  const result = await t.agent.doIntent("open it", "it is open", "");
  assert.equal(t.acts.length, 0);
  assert.equal(
    result.split("\n")[0],
    "DREX handed back: Drex says the step is done but its screen check gives only 10%. Its top options: step done (90%)",
  );
});

test("do: a move that act refused is reported as not made, with its note, not as one that changed nothing", async () => {
  const t = setup({
    drex: [says("click E2", 0.9, 0.1)],
    moved: { changed: false, note: "Target could not be resolved before dispatch" },
    outcome: { blocked: "stale target" },
  });
  const result = await t.agent.doIntent("open it", "it is open", "");
  assert.ok(
    result.startsWith(
      `DREX handed back: stale target\n${fenced("MOVES:\n1. clicked link 'Orders' -> not made: Target could not be resolved before dispatch")}\nPAGE NOW:\n`,
    ),
    result,
  );
});

test("do: a risky click that Drex gives under RISKY_P is handed back; at RISKY_P, or a harmless one, it is made", async () => {
  const els = [control("E1", "button", "Place order"), control("E2", "link", "Orders")];
  const handed = setup({ els, off: [], drex: [says("click E1", 0.4, 0.1, { "click E2": 0.3 })] });
  const result = await handed.agent.doIntent("place the order", "the order is placed", "");
  assert.equal(handed.acts.length, 0);
  assert.equal(handed.agent.totals.drexMoves, 0);
  assert.equal(
    result.split("\n")[0],
    "DREX handed back: a risky move at only 40%. Its top options: click E1 (40%), click E2 (30%)",
  );
  const sure = setup({ els, off: [], drex: [says("click E1", RISKY_P, 0.1), says("click E1", 0.9, 0.97)] });
  await sure.agent.doIntent("place the order", "the order is placed", "");
  assert.equal(sure.acts.length, 1);
  assert.equal(sure.acts[0].act.el.label, "E1");
  const harmless = setup({ els, off: [], drex: [says("click E2", 0.4, 0.1), says("click E2", 0.9, 0.97)] });
  await harmless.agent.doIntent("open the orders", "the orders are open", "");
  assert.equal(harmless.acts.length, 1);
});

test("do: three moves in a row that changed nothing hand back, whatever they were", async () => {
  const t = setup({
    drex: [
      says("click E2", 0.9, 0.1),
      says("click E3", 0.9, 0.1),
      says("scroll down", 0.9, 0.1),
      says("press tab", 0.9, 0.1),
    ],
    moved: { changed: false },
  });
  const result = await t.agent.doIntent("open it", "it is open", "");
  assert.equal(t.acts.length, 3);
  assert.match(result.split("\n")[0], /^DREX handed back: .*last 3 moves changed nothing/);
});

test("do: with the intent never done, Drex makes exactly DO_MAX_MOVES moves, is asked once more whether the last did it, and stops", async () => {
  const t = setup({ drex: [says("click E2", 0.9, 0.1)] });
  const result = await t.agent.doIntent("open it", "it is open", "");
  assert.equal(t.acts.length, DO_MAX_MOVES);
  assert.equal(t.drexCalls.length, DO_MAX_MOVES + 1); // the check after the last move is the one more
  assert.equal(t.agent.totals.drexMoves, DO_MAX_MOVES);
  assert.equal(t.looks.n, DO_MAX_MOVES + 1); // the screen is read afresh for each move, and for that check
  assert.equal(result.split("\n")[0], "DREX stopped after 6 moves");
  assert.equal(result.split("\n").filter((l) => /^\d+\. /.test(l)).length, 6);
});

// Drex's answer to the question of the check after the last move: the done question, and no move
const closes = (done) => ({ answers: { done: { noul: done } }, usage: { input_tokens: 500 }, ms: 9, usd: 0.00004 });
const sixMoves = () => Array.from({ length: DO_MAX_MOVES }, () => says("click E2", 0.9, 0.1));

test("do: the last move may be the one that did it: Drex is asked the done question alone, and the report says done", async () => {
  const t = setup({ drex: [...sixMoves(), closes(0.93)] });
  const result = await t.agent.doIntent("open it", "it is open", "");
  assert.equal(t.acts.length, DO_MAX_MOVES);
  assert.equal(t.drexCalls.length, DO_MAX_MOVES + 1);
  const closing = t.drexCalls.at(-1);
  assert.deepEqual(Object.keys(closing.questions), ["done"]);
  assert.deepEqual(closing.questions.done, {
    type: "noul",
    instructions: "it is open Answer from Image 1, the screen now.",
  });
  assert.deepEqual(closing.images, [IMG1, IMG2]);
  assert.match(closing.state, /YOUR MOVES IN THIS STEP SO FAR \(6 of at most 6;[^\n]*\n1\. clicked link 'Orders'/);
  assert.ok(
    result.startsWith(
      `DREX done (93% sure: it is open)\n<page-data id="${NONCE}">\nMOVES:\n1. clicked link 'Orders' -> the screen changed\n`,
    ),
    result,
  );
  assert.equal(result.split("\n").filter((l) => /^\d+\. /.test(l)).length, DO_MAX_MOVES);
  assert.equal(t.agent.handedBack, false); // finished: Drex does the page's work again
  assert.equal(t.agent.totals.drexMoves, DO_MAX_MOVES);
  // a done step has its move row, and no row for the cap
  assert.deepEqual(
    t.events.filter((e) => e.type === "tab"),
    [],
  );
  const row = t.events.findLast((e) => e.type === "move" && e.what === "the step is done");
  assert.equal(row.p, 0.93);
  assert.equal(t.events.filter((e) => e.type === "decision").length, DO_MAX_MOVES); // that check chose no move
});

test("do: a check after the last move that is not sure leaves it at the cap; one after a hover cannot end the step", async () => {
  const unsure = setup({ drex: [...sixMoves(), closes(0.5)] });
  assert.equal((await unsure.agent.doIntent("open it", "it is open", "")).split("\n")[0], "DREX stopped after 6 moves");
  assert.equal(unsure.agent.handedBack, true);
  // the last move only pointed at something: only a move of Drex's own may end the step then
  const hover = setup({ drex: [...sixMoves(), closes(0.97)], moved: { revealOnly: true } });
  assert.equal((await hover.agent.doIntent("open it", "it is open", "")).split("\n")[0], "DREX stopped after 6 moves");
});

test("do: no check follows a do that ended before the cap, whether it handed back or was done", async () => {
  const handed = setup({ drex: [says("click E2", 0.9, 0.1), says("ask for help", 0.9, 0.1)] });
  await handed.agent.doIntent("open it", "it is open", "");
  assert.equal(handed.drexCalls.length, 2);
  const done = setup({ drex: [says("click E2", 0.9, 0.1), says("click E2", 0.9, 0.1), says("click E2", 0.9, 0.95)] });
  await done.agent.doIntent("open it", "it is open", "");
  assert.equal(done.drexCalls.length, 3);
});

test("do: a step the page already shows done takes no move", async () => {
  const t = setup({ drex: [says("click E2", 0.9, 0.97)] });
  const result = await t.agent.doIntent("open it", "it is open", "");
  assert.equal(t.acts.length, 0);
  assert.ok(result.startsWith(`DREX done (97% sure: it is open)\n${fenced("MOVES: none")}\n`), result);
});

test("do: the step is installed as the plan's only step, and the per-step state starts again", async () => {
  const t = setup({ drex: [says("ask for help", 0.9, 0.1)] });
  t.agent.readbackMisses = 3;
  t.agent.sortRefusals = 2;
  t.agent.stepClicks = ["Apply"];
  t.agent.stepChosen = ["Complete"];
  t.agent.incompleteChecks = 2;
  t.agent.index = 4;
  await t.agent.doIntent("set the status", "the status is Complete", "Complete");
  assert.deepEqual(t.agent.plan.steps[0], {
    kind: "browse",
    goal: "set the status",
    done_when: "the status is Complete",
    open_url: "",
    use_tab: -1,
    rules: "",
    max_moves: DO_MAX_MOVES,
    question: "",
    choices: [],
    texts: [{ name: "text", text: "Complete" }],
    save_as: "",
  });
  assert.equal(t.agent.plan.steps.length, 1);
  assert.equal(t.agent.index, 0);
  assert.equal(t.agent.readbackMisses, 0);
  assert.equal(t.agent.sortRefusals, 0);
  assert.deepEqual(t.agent.stepClicks, []);
  assert.deepEqual(t.agent.stepChosen, []);
  assert.equal(t.agent.incompleteChecks, 0);
});

test("do: without an expectation the step is done when the intent is visibly done; without a text it has none", async () => {
  const t = setup({ drex: [says("ask for help", 0.9, 0.1)] });
  await t.agent.doIntent("open it", "", "");
  const step = t.agent.plan.steps[0];
  assert.equal(step.done_when, "the intent is visibly done");
  assert.deepEqual(step.texts, []);
  assert.equal(
    t.drexCalls[0].questions.done.instructions,
    "the intent is visibly done Answer from Image 1, the screen now.",
  );
});

test("do: Drex gets the state, the move choice with every option, the done question, and both screenshots", async () => {
  const t = setup({ drex: [says("click E2", 0.9, 0.1), says("click E2", 0.9, 0.99)] });
  await t.agent.doIntent("open the orders page", "the order list is open", "hello");
  const [first, second] = t.drexCalls;
  assert.match(first.state, new RegExp(`THE USER'S TASK: ${TASK}\n`));
  assert.match(first.state, /YOUR STEP NOW: open the orders page\nIT IS DONE WHEN: the order list is open\n/);
  assert.match(first.state, /TEXT YOU CAN TYPE[^\n]*\n- text: /);
  assert.match(first.state, /YOUR MOVES IN THIS STEP SO FAR \(0 of at most 6;/);
  assert.match(
    first.state,
    /THE PAGE ON SCREEN: "Orders" at https:\/\/shop\.example\/orders\nImage 1 is the screen now\./,
  );
  assert.match(second.state, /YOUR MOVES IN THIS STEP SO FAR \(1 of at most 6;[^\n]*\n1\. clicked link 'Orders'/);
  assert.equal(first.questions.move.type, "choice");
  assert.equal(first.questions.move.instructions, MOVE_Q);
  const options = first.questions.move.criteria;
  for (const key of [
    "click E1",
    "click E2",
    "click E3",
    "type text into E1",
    "choose 'Complete' in E5",
    "scroll down",
    "ask for help",
  ])
    assert.ok(key in options, key);
  assert.ok(!("type text into E2" in options));
  assert.ok(!("click E5" in options)); // a native select is not clicked
  assert.ok("click D1" in options); // an off-screen control is offered too
  assert.deepEqual(first.questions.done, {
    type: "noul",
    instructions: "the order list is open Answer from Image 1, the screen now.",
  });
  assert.deepEqual(first.images, [IMG1, IMG2]);
});

test("do: moves that need a second question or the LLM's writing are not offered, whatever the build's switches", async () => {
  const cards = [
    control("E1", "textbox", "Title", { field: true, ownText: true }),
    control("E2", "listitem", "Card A", { draggable: true, ownText: true }),
    control("E3", "listitem", "Card B", { draggable: true, ownText: true }),
  ];
  // browse() offers a drag and a copy for such a step with the switches on, and a move the LLM writes with no plan
  const browse = Object.keys(
    buildOptions({ els: cards, dragTo: true, dragHint: true, copyMove: true, copyHint: true, direct: true }).opts,
  );
  assert.ok(browse.some((k) => k.startsWith("drag ")));
  assert.ok(browse.some((k) => k.startsWith("copy the text")));
  assert.ok(browse.includes("type into E1") && browse.includes("type at the cursor"));
  const t = setup({
    drex: [says("ask for help", 0.9, 0.1)],
    els: cards,
    off: [],
    Kind: switched.LoopAgent,
    options: { planning: false },
  });
  await t.agent.doIntent("drag card A onto card B and copy the text", "done", "x");
  const keys = Object.keys(t.drexCalls[0].questions.move.criteria);
  assert.ok(!keys.some((k) => k.startsWith("drag ") || k.startsWith("copy the text")), keys.join());
  assert.ok(!keys.includes("type into E1") && !keys.includes("type at the cursor"), keys.join());
  assert.ok(!keys.includes("ask if finished"), keys.join());
  assert.ok(keys.includes("step done"));
  assert.ok(keys.includes("type text into E1")); // the one text the LLM gave is typed by an ordinary move
});

test("do: the text is typed by the move Drex chooses, and act gets the move as browse gives it", async () => {
  const t = setup({ drex: [says("type text into E1", 0.8, 0.1), says("click E3", 0.9, 0.99)] });
  await t.agent.doIntent("search for the order", "the search is typed", "order 7");
  const [typing] = t.acts;
  assert.equal(typing.act.kind, "type");
  assert.equal(typing.act.el.label, "E1");
  assert.equal(typing.text, "order 7");
  assert.equal(typing.tab, t.tab);
  assert.equal(typing.scr, t.screen);
  assert.equal(typing.who, "drex");
  assert.equal(typing.p, 0.8);
  assert.equal(typing.note, "");
  assert.deepEqual(typing.opts, { prechecked: true, step: t.agent.plan.steps[0] });
});

// A form with a title and a body, where the one `text` of a do used to land in both fields
const POST_FORM = [
  control("E1", "textbox", "Title", { field: true }),
  control("E2", "textbox", "Body", { field: true }),
  control("E3", "button", "Save"),
];
const stepTexts = (t) => t.agent.plan.steps[0].texts;

test("do: a text for each field is named for its field, listed in Drex's state, and typed into that field", async () => {
  const replies = [
    says("type title into E1", 0.8, 0.1),
    says("type body into E2", 0.8, 0.1),
    says("click E3", 0.9, 0.99),
  ];
  const t = setup({ els: POST_FORM, off: [], drex: () => replies.shift() });
  const texts = [
    { field: "Title", text: "My first post" },
    { field: "Body", text: "Hello, this is the body." },
  ];
  const result = await t.agent.doIntent("fill in the post form", "both fields are filled", "", texts);
  assert.deepEqual(stepTexts(t), [
    { name: "title", text: "My first post" },
    { name: "body", text: "Hello, this is the body." },
  ]);
  const [first] = t.drexCalls;
  assert.match(first.state, /TEXT YOU CAN TYPE[^\n]*\n- title: 'My first post'\n- body: 'Hello, this is the body\.'\n/);
  // each text is offered for each field, by its name
  const options = Object.keys(first.questions.move.criteria);
  for (const key of ["type title into E1", "type title into E2", "type body into E1", "type body into E2"])
    assert.ok(options.includes(key), key);
  assert.ok(!options.some((k) => k.startsWith("type text into")), options.join());
  assert.deepEqual(
    t.acts.map((a) => [a.act.kind, a.act.el.label, a.text]),
    [
      ["type", "E1", "My first post"],
      ["type", "E2", "Hello, this is the body."],
    ],
  );
  // the report of the moves, between the run's markers, names both fields
  assert.ok(
    result.startsWith(
      `DREX done (99% sure: both fields are filled)\n${fenced("MOVES:\n1. typed 'My first post' into textbox 'Title' -> the screen changed\n2. typed 'Hello, this is the body.' into textbox 'Body' -> the screen changed")}\nPAGE NOW:\n`,
    ),
    result,
  );
});

test("do: fields that are named alike get _2, _3 and so on, so each keeps its own text", async () => {
  const t = setup({ drex: [says("ask for help", 0.9, 0.1)] });
  const texts = ["Ann", "Bo", "Cy"].map((text) => ({ field: "Name", text }));
  await t.agent.doIntent("fill in the names", "the names are filled", "", texts);
  assert.deepEqual(stepTexts(t), [
    { name: "name", text: "Ann" },
    { name: "name_2", text: "Bo" },
    { name: "name_3", text: "Cy" },
  ]);
  const options = Object.keys(t.drexCalls[0].questions.move.criteria);
  for (const key of ["type name into E1", "type name_2 into E1", "type name_3 into E1"])
    assert.ok(options.includes(key), key);
  assert.match(t.drexCalls[0].state, /\n- name: 'Ann'\n- name_2: 'Bo'\n- name_3: 'Cy'\n/);
});

test("do: a field's name is lowercased, its other characters become _, and at most 24 characters are kept", async () => {
  const cases = [
    ["Title", "title"],
    ["Post Title", "post_title"],
    ["E-mail", "e_mail"],
    ["Line 2", "line_2"],
    ["Address Line 1 (street and house number)", "address_line_1_street_an"],
    ["Заголовок поста", "заголовок_поста"], // letters of any script are kept
    ["x".repeat(24), "x".repeat(24)],
    ["x".repeat(30), "x".repeat(24)],
  ];
  for (const [field, name] of cases) {
    const t = setup({ drex: [says("ask for help", 0.9, 0.1)] });
    await t.agent.doIntent("fill it in", "it is filled", "", [{ field, text: "v" }]);
    assert.deepEqual(stepTexts(t), [{ name, text: "v" }], field);
  }
});

test("do: a name stays unique, and within 24 characters, when a long field is repeated", async () => {
  const t = setup({ drex: [says("ask for help", 0.9, 0.1)] });
  const long = "A very long field name that goes on and on";
  await t.agent.doIntent("fill it in", "it is filled", "", [
    { field: long, text: "one" },
    { field: long, text: "two" },
    { field: long, text: "three" },
  ]);
  const names = stepTexts(t).map((x) => x.name);
  assert.equal(new Set(names).size, 3);
  assert.deepEqual(
    names.map((n) => n.length),
    [24, 24, 24],
  );
  assert.equal(names[0], "a_very_long_field_name_t");
  assert.deepEqual(
    names.slice(1).map((n) => n.slice(-2)),
    ["_2", "_3"],
  );
});

test("do: the single text comes last and keeps the name text, so a field called Text is named text_2", async () => {
  const t = setup({ drex: [says("ask for help", 0.9, 0.1)] });
  await t.agent.doIntent("fill in the form", "it is filled", "the search words", [
    { field: "Title", text: "T" },
    { field: "Text", text: "the field that is called Text" },
  ]);
  assert.deepEqual(stepTexts(t), [
    { name: "title", text: "T" },
    { name: "text_2", text: "the field that is called Text" },
    { name: "text", text: "the search words" },
  ]);
  const same = setup({ drex: [says("ask for help", 0.9, 0.1)] });
  await same.agent.doIntent("fill it in", "it is filled", "", [{ field: "Text", text: "x" }]);
  assert.deepEqual(stepTexts(same), [{ name: "text", text: "x" }]); // with no single text, the name is free
});

test("do: with no texts or an empty text, the step has only the single text, as before", async () => {
  const cases = [
    [["go", "done", "hi"], [{ name: "text", text: "hi" }]],
    [["go", "done", "hi", []], [{ name: "text", text: "hi" }]],
    [["go", "done", "", []], []],
    [["go", "done", ""], []],
  ];
  for (const [args, expected] of cases) {
    const t = setup({ drex: [says("ask for help", 0.9, 0.1)] });
    await t.agent.doIntent(...args);
    assert.deepEqual(stepTexts(t), expected, JSON.stringify(args));
  }
});

test("do: the fields' texts and the single text are all listed and all offered as moves", async () => {
  const t = setup({ els: POST_FORM, off: [], drex: [says("ask for help", 0.9, 0.1)] });
  await t.agent.doIntent("fill it in", "it is filled", "extra", [
    { field: "Title", text: "T" },
    { field: "Body", text: "B" },
  ]);
  const options = Object.keys(t.drexCalls[0].questions.move.criteria);
  for (const name of ["title", "body", "text"]) assert.ok(options.includes(`type ${name} into E1`), name);
  assert.match(t.drexCalls[0].state, /\n- title: 'T'\n- body: 'B'\n- text: 'extra'\n/);
});

const fieldTexts = (n) => Array.from({ length: n }, (_, i) => ({ field: `Field ${i + 1}`, text: `value ${i + 1}` }));
const TOO_MANY = "DREX handed back: Drex can fill at most 4 fields per do; split the fields over several do actions";

test("do: more than 4 texts are handed back at once, with no call to Drex, no look at the page and no change to the plan", async () => {
  const t = setup({ drex: [says("ask for help", 0.9, 0.1)], handedBack: false });
  const before = structuredClone(t.agent.plan.steps[0]);
  assert.equal(await t.agent.doIntent("fill it in", "it is filled", "", fieldTexts(DO_MAX_TEXTS + 1)), TOO_MANY);
  assert.equal(t.drexCalls.length, 0);
  assert.equal(t.looks.n, 0);
  assert.equal(t.tab.reads, 0);
  assert.equal(t.acts.length, 0);
  assert.deepEqual(t.agent.plan.steps[0], before);
  assert.equal(t.agent.handedBack, false); // nothing was tried, so the LLM still leaves the page's work to Drex
  assert.deepEqual(
    t.events.filter((e) => e.type === "tab").map((e) => e.what),
    [TOO_MANY.replace("DREX", "Drex")],
  );
  // the single text is one of the texts Drex gets
  const mixed = setup({ drex: [says("ask for help", 0.9, 0.1)] });
  assert.equal(await mixed.agent.doIntent("fill it in", "it is filled", "extra", fieldTexts(DO_MAX_TEXTS)), TOO_MANY);
  assert.equal(mixed.drexCalls.length, 0);
});

test("do: up to 4 texts, the single text included, go to Drex", async () => {
  for (const [text, n] of [
    ["", 4],
    ["extra", 3],
    ["extra", 0],
  ]) {
    const t = setup({ drex: [says("ask for help", 0.9, 0.1)] });
    const result = await t.agent.doIntent("fill it in", "it is filled", text, fieldTexts(n));
    assert.notEqual(result, TOO_MANY);
    assert.equal(t.drexCalls.length, 1, `${n} fields and ${JSON.stringify(text)}`);
    assert.equal(t.agent.plan.steps[0].texts.length, n + (text ? 1 : 0));
  }
});

test("do: the cap of 4 texts is where buildOptions stops offering a move for each text", () => {
  // logic.ts's INLINE_TEXTS: up to it every text is a move of its own; above it there is one move that asks a second
  // question, which the loop does not answer
  const field = [control("E1", "textbox", "Title", { field: true })];
  const keys = (n) =>
    Object.keys(
      buildOptions({ els: field, texts: Array.from({ length: n }, (_, i) => ({ name: `t${i + 1}`, text: "x" })) }).opts,
    );
  assert.equal(DO_MAX_TEXTS, 4);
  assert.ok(keys(DO_MAX_TEXTS).includes(`type t${DO_MAX_TEXTS} into E1`));
  assert.ok(!keys(DO_MAX_TEXTS).includes("type into E1"));
  assert.ok(keys(DO_MAX_TEXTS + 1).includes("type into E1"));
  assert.ok(!keys(DO_MAX_TEXTS + 1).includes("type t1 into E1"));
});

test("do: act's refusal hands back with its reason, the moves made so far in the report", async () => {
  const cases = [
    [{ blocked: "stale target" }, /^DREX handed back: stale target$/],
    [{ fail: "the step got stuck" }, /^DREX handed back: the step got stuck$/],
    [{ replan: [{ kind: "browse" }], why: "the setting did not hold" }, /^DREX handed back: the setting did not hold$/],
    [{ replan: [{ kind: "browse" }] }, /^DREX handed back: blocked$/],
  ];
  for (const [outcome, first] of cases) {
    const t = setup({ drex: [says("click E2", 0.9, 0.1)], outcome });
    const result = await t.agent.doIntent("open it", "it is open", "");
    assert.equal(t.acts.length, 1, JSON.stringify(outcome));
    assert.equal(t.drexCalls.length, 1, JSON.stringify(outcome));
    assert.match(result.split("\n")[0], first);
    assert.ok(
      result.includes(`\n${fenced("MOVES:\n1. clicked link 'Orders' -> the screen changed")}\nPAGE NOW:\n`),
      result,
    );
  }
});

test("do: a move's effect is shown, and a move that changed nothing says so", async () => {
  const t = setup({ drex: [says("click E2", 0.9, 0.1), says("click E3", 0.9, 0.1), says("click E3", 0.9, 0.1)] });
  let n = 0;
  const entries = [{ effect: 'opened "Filters"' }, { changed: false }];
  const act = t.agent.act;
  t.agent.act = async (...args) => {
    const r = await act(...args);
    Object.assign(args[4].at(-1), entries[n++] ?? {});
    return r;
  };
  const result = await t.agent.doIntent("open it", "it is open", "");
  assert.match(
    result,
    /\n1\. clicked link 'Orders' -> opened "Filters"\n2\. clicked button 'Apply' -> nothing changed\n/,
  );
});

test("do: the done step and each Drex decision are logged for the panel and the run's record", async () => {
  const t = setup({ drex: [says("click E2", 0.9, 0.1, { "click E3": 0.05 }), says("ask for help", 0.9, 0.95)] });
  await t.agent.doIntent("open it", "it is open", "");
  const decision = t.events.find((e) => e.type === "decision");
  assert.equal(decision.who, "drex");
  assert.equal(decision.choice, "click E2");
  assert.equal(decision.p, 0.9);
  assert.equal(decision.doneP, 0.1);
  assert.equal(decision.ms, 12);
  assert.equal(decision.usd, 0.00006);
  assert.equal(decision.url, START);
  assert.deepEqual(decision.top, [
    ["click E2", 0.9],
    ["click E3", 0.05],
  ]);
  const done = t.events.find((e) => e.type === "move" && e.what === "the step is done");
  assert.equal(done.who, "drex");
  assert.equal(done.p, 0.95);
  assert.equal(done.ms, 12);
  assert.equal(t.events.filter((e) => e.type === "move").length, 1); // act logs the moves; the fake act logs none
  assert.ok(t.events.findIndex((e) => e.type === "decision") < t.events.findIndex((e) => e.type === "move"));
});

test("do: a hand back leaves its decision and a row saying so; so does the cap; a done step has its move row instead", async () => {
  const handed = setup({ drex: [says("ask for help", 0.8, 0.1)] });
  await handed.agent.doIntent("open it", "it is open", "");
  const decision = handed.events.find((e) => e.type === "decision");
  assert.equal(decision.choice, "ask for help");
  assert.equal(decision.p, 0.8);
  assert.deepEqual(
    handed.events.filter((e) => e.type === "tab").map((e) => e.what),
    ["Drex handed back: Drex chose 'ask for help'. Its top options: ask for help (80%)"],
  );
  const capped = setup({ drex: [says("click E2", 0.9, 0.1)] });
  await capped.agent.doIntent("open it", "it is open", "");
  assert.deepEqual(
    capped.events.filter((e) => e.type === "tab").map((e) => e.what),
    ["Drex stopped after 6 moves"],
  );
  const done = setup({ drex: [says("step done", 0.9, 0.9)] });
  await done.agent.doIntent("open it", "it is open", "");
  assert.deepEqual(
    done.events.filter((e) => e.type === "tab"),
    [],
  );
  assert.equal(done.events.filter((e) => e.type === "move").length, 1);
});

test("do: Stop ends it at once, with no call to Drex", async () => {
  const t = setup({ drex: [says("click E2", 0.9, 0.1)] });
  t.agent.stop();
  await assert.rejects(t.agent.doIntent("open it", "it is open", ""), /Stopped by you/);
  assert.equal(t.drexCalls.length, 0);
});

test("do: an error from Drex or from the move hands back with the moves made so far, and the error", async () => {
  const drexFails = setup({
    drex: (call, n) => {
      if (n === 0) return says("click E2", 0.9, 0.1);
      throw new Error('Drex reply has no answer "done"');
    },
  });
  const result = await drexFails.agent.doIntent("open it", "it is open", "");
  assert.equal(result.split("\n")[0], 'DREX handed back: Drex reply has no answer "done"');
  assert.ok(
    result.includes(`\n${fenced("MOVES:\n1. clicked link 'Orders' -> the screen changed")}\nPAGE NOW:\n`),
    result,
  );
  assert.equal(drexFails.acts.length, 1);
  assert.equal(drexFails.agent.handedBack, true); // the LLM may take it from here
  assert.deepEqual(
    drexFails.events.filter((e) => e.type === "tab").map((e) => e.what),
    ['Drex handed back: Drex reply has no answer "done"'],
  );
  // a failure no later call can mend is no hand-back: it ends the run (the key, the account, the service)
  const keyFails = setup({
    drex: (call, n) => {
      if (n === 0) return says("click E2", 0.9, 0.1);
      throw new Error("Drex call failed: HTTP 402: no credit");
    },
  });
  await assert.rejects(
    () => keyFails.agent.doIntent("open it", "it is open", ""),
    /^Error: Drex call failed: HTTP 402/,
  );
  const moveFails = setup({ drex: [says("click E2", 0.9, 0.1)] });
  moveFails.agent.act = async () => {
    throw new Error("The control's box\n    is missing"); // its words stay on the report's first line
  };
  const second = await moveFails.agent.doIntent("open it", "it is open", "");
  assert.ok(
    second.startsWith(`DREX handed back: The control's box is missing\n${fenced("MOVES: none")}\nPAGE NOW:\n`),
    second,
  );
});

test("do: a hand-over and a run limit end the run: they are not handed back as errors", async () => {
  const handover = setup({ drex: [says("click E2", 0.9, 0.1)], options: { unattended: true } });
  handover.agent.act = () => handover.agent.waitForUser("user", "A login is needed");
  await assert.rejects(handover.agent.doIntent("open it", "it is open", ""), /A login is needed/);
  // the run's budget runs out while a move is made
  const limit = setup({ drex: [says("click E2", 0.9, 0.1)] });
  const act = limit.agent.act;
  limit.agent.act = async (...args) => {
    const r = await act(...args);
    limit.agent.runBudget.uncertain = true;
    return r;
  };
  await assert.rejects(limit.agent.doIntent("open it", "it is open", ""), /unknown cost/);
  assert.equal(limit.acts.length, 1);
});

test("do: the Drex calls are counted in the run's totals by drexCall itself", async () => {
  const t = setup({ drex: [] });
  delete t.agent.drexCall; // the real one, over a Drex client that answers from a script
  const replies = [says("click E2", 0.9, 0.1), says("click E2", 0.9, 0.95)];
  t.agent.drex = { ask: async () => replies.shift() };
  await t.agent.doIntent("open it", "it is open", "");
  assert.equal(t.agent.totals.drexCalls, 2);
  assert.equal(t.agent.totals.drexUsd, 0.00012);
  assert.equal(t.agent.totals.drexMoves, 1);
});

test("do: the Drex share of a run: one move takes two Drex calls, the move and the check that it is done", async () => {
  const t = setup({ drex: [says("click E2", 0.9, 0.1), says("click E2", 0.9, 0.95)] });
  await t.agent.doIntent("open it", "it is open", "");
  assert.ok(t.drexCalls.length >= 2);
  assert.equal(t.agent.totals.drexMoves, 1);
});

test("do: with the drexText switch the screens are not sent, and the done question says to read the page", async () => {
  const t = setup({ drex: [says("click E2", 0.9, 0.1), says("click E2", 0.9, 0.97)], Kind: textOnly.LoopAgent });
  await t.agent.doIntent("open it", "it is open", "");
  const [first] = t.drexCalls;
  assert.deepEqual(first.images, []);
  assert.equal(first.questions.done.instructions, "it is open Answer from the page as it is now.");
  assert.match(first.state, /You read the screen from its elements/);
});

test("with the drexCompact switch Drex reads the task without its answer-format paragraphs, in every tool", async () => {
  const task = "Find the total of the orders.\n\nReturn the answer as a JSON object with the field total.";
  const t = setup({ Kind: compact.LoopAgent, drex: [says("ask for help", 0.9, 0.1)] });
  t.agent.task = task;
  await t.agent.doIntent("open it", "it is open", "");
  t.agent.drexCall = async (state, questions, images) => {
    t.drexCalls.push({ state, questions, images });
    return decides(() => "ok")({ questions });
  };
  await t.agent.pickRows(["a"], "Q?", ["ok", "no"]);
  t.agent.drexCall = async (state, questions, images) => {
    t.drexCalls.push({ state, questions, images });
    return { answers: { check: { noul: 0.5 } }, usage: {}, ms: 1, usd: 0 };
  };
  await t.agent.checkClaim("it is open");
  assert.equal(t.drexCalls.length, 3);
  for (const { state } of t.drexCalls) {
    assert.match(state, /THE USER'S TASK: Find the total of the orders\./);
    assert.ok(!state.includes("JSON"), state);
  }
});

test("pick: 20 rows are decided in two Drex calls of 16 and 4 questions, and counted as 20 items", async () => {
  const rows = Array.from({ length: 20 }, (_, i) => `row ${i + 1}`);
  const t = setup({ drex: decides(() => "ok") });
  await t.agent.pickRows(rows, "Is the item spam?", ["spam", "ok"]);
  assert.equal(t.drexCalls.length, 2);
  assert.deepEqual(
    t.drexCalls.map((c) => Object.keys(c.questions).length),
    [16, 4],
  );
  assert.deepEqual(
    Object.keys(t.drexCalls[0].questions),
    Array.from({ length: 16 }, (_, i) => `i${i + 1}`),
  );
  assert.deepEqual(Object.keys(t.drexCalls[1].questions), ["i1", "i2", "i3", "i4"]);
  assert.equal(t.agent.totals.drexItems, 20);
  assert.equal(t.agent.totals.drexMoves, 0);
});

test("pick: each question quotes its row and asks the question; the choices are their own criteria; no images", async () => {
  const t = setup({ drex: decides(() => "ok") });
  await t.agent.pickRows(["Win a prize now", "Meeting at 3"], "Is the item spam?", ["spam", "ok"]);
  const [call] = t.drexCalls;
  assert.equal(call.state, `THE USER'S TASK: ${TASK}\nDecide each ITEM below. Is the item spam?`);
  assert.deepEqual(call.questions, {
    i1: {
      type: "choice",
      instructions: 'ITEM: "Win a prize now"\nIs the item spam?',
      criteria: { spam: "spam", ok: "ok" },
    },
    i2: {
      type: "choice",
      instructions: 'ITEM: "Meeting at 3"\nIs the item spam?',
      criteria: { spam: "spam", ok: "ok" },
    },
  });
  assert.deepEqual(call.images, []);
});

test("pick: the result has one line per row, in the row order, whichever call decided it", async () => {
  const rows = Array.from({ length: 18 }, (_, i) => (i % 3 === 0 ? `spam ${i + 1}` : `fine ${i + 1}`));
  const t = setup({ drex: decides((text) => (text.includes("spam") ? "spam" : "ok")) });
  const result = await t.agent.pickRows(rows, "What kind of item is it?", ["spam", "ok"]);
  const lines = result.split("\n");
  assert.equal(lines.length, 18);
  assert.equal(lines[0], "1. spam 1 -> spam (90%)");
  assert.equal(lines[1], "2. fine 2 -> ok (90%)");
  assert.equal(lines[17], "18. fine 18 -> ok (90%)");
  rows.forEach((row, i) => assert.ok(lines[i].startsWith(`${i + 1}. ${row} -> `), lines[i]));
});

test("pick: a row is shown on one line, cut to 80 characters; Drex still gets all of it", async () => {
  const long = `${"word ".repeat(40)}end`;
  const t = setup({ drex: decides(() => "ok") });
  const result = await t.agent.pickRows([long, "two\nlines"], "Q?", ["ok", "no"]);
  const [first, second] = result.split("\n");
  assert.equal(first, `1. ${long.slice(0, 80)} -> ok (90%)`);
  assert.equal(second, "2. two lines -> ok (90%)");
  assert.ok(t.drexCalls[0].questions.i1.instructions.includes(long));
  assert.ok(t.drexCalls[0].questions.i2.instructions.includes("two\nlines"));
});

test("pick: a decision is logged as a batch of items for the panel", async () => {
  const t = setup({ drex: decides((text) => (text.includes("spam") ? "spam" : "ok")) });
  await t.agent.pickRows(["spam a", "fine b", "spam c"], "Q?", ["spam", "ok"]);
  const batch = t.events.find((e) => e.type === "batch");
  assert.equal(batch.items, 3);
  assert.equal(batch.calls, 1);
  assert.deepEqual(batch.counts, { spam: 2, ok: 1 });
  assert.ok(Math.abs(batch.usd - 0.0002) < 1e-12);
  assert.equal(typeof batch.ms, "number");
});

test("pick: a reply with no answer for a row is an error the loop reports, not a guess", async () => {
  const t = setup({ drex: () => ({ answers: {}, usage: {}, ms: 1, usd: 0 }) });
  await assert.rejects(t.agent.pickRows(["a"], "Q?", ["x", "y"]), /no answer "i1"/);
});

test("check: one Drex call with the task, the page and the claim, and the screen; the result gives the percentage", async () => {
  const t = setup({ drex: () => ({ answers: { check: { noul: 0.913 } }, usage: {}, ms: 1, usd: 0 }) });
  const result = await t.agent.checkClaim("the cart has 2 items.");
  assert.equal(result, 'Drex: 91% that "the cart has 2 items."');
  assert.equal(t.drexCalls.length, 1);
  const [call] = t.drexCalls;
  assert.equal(call.state, `THE USER'S TASK: ${TASK}\nTHE PAGE: Orders at ${START}`);
  assert.deepEqual(call.questions, {
    check: { type: "noul", instructions: "the cart has 2 items. Answer from Image 1, the screen now." },
  });
  assert.deepEqual(call.images, [IMG1]);
  assert.equal(t.looks.n, 1);
  assert.equal(t.agent.totals.drexMoves, 0);
});

test("check: the screen goes with the claim even when moves are decided from text alone", async () => {
  const t = setup({
    drex: () => ({ answers: { check: { noul: 0.4 } }, usage: {}, ms: 1, usd: 0 }),
    Kind: textOnly.LoopAgent,
  });
  assert.equal(await t.agent.checkClaim("the filter is on"), 'Drex: 40% that "the filter is on"');
  assert.deepEqual(t.drexCalls[0].images, [IMG1]);
});

test("check: an answer with no probability is an error the loop reports", async () => {
  const t = setup({ drex: () => ({ answers: { check: {} }, usage: {}, ms: 1, usd: 0 }) });
  await assert.rejects(t.agent.checkClaim("x"), /no probability/);
});

test("click: the click move of the element is made as the LLM's own, and the short view comes back", async () => {
  const t = setup();
  const result = await t.agent.clickEl("E2");
  assert.equal(t.acts.length, 1);
  const [c] = t.acts;
  assert.equal(c.act.kind, "click");
  assert.equal(c.act.el.label, "E2");
  assert.equal(c.text, undefined);
  assert.equal(c.tab, t.tab);
  assert.equal(c.scr, t.screen);
  assert.equal(c.who, "llm");
  assert.equal(c.p, undefined);
  assert.equal(c.note, "the LLM's own move");
  assert.deepEqual(c.opts, { prechecked: true, step: t.agent.plan.steps[0] });
  assert.equal(result, view());
  assert.equal(t.looks.n, 1);
  assert.equal(t.drexCalls.length, 0);
  assert.equal(t.agent.totals.drexMoves, 0);
});

test("click: a field is clicked, an off-screen control is scrolled to and clicked", async () => {
  const t = setup();
  await t.agent.clickEl("E1");
  await t.agent.clickEl("D1");
  assert.deepEqual(
    t.acts.map((a) => [a.act.kind, a.act.el.label]),
    [
      ["click", "E1"],
      ["scroll_click", "D1"],
    ],
  );
});

test("click: a tag that is not clickable comes back as text with no move; one that is not on the page says it changed", async () => {
  const t = setup();
  const message = (el) => `${el} is not a click target on this page; use page to see the controls`;
  const changed = (el) => `${el} changed since your last page view. The page now:\n${view()}`;
  assert.equal(await t.agent.clickEl("E5"), message("E5")); // a native select takes a choice, not a click
  assert.equal(await t.agent.clickEl("E99"), changed("E99"));
  assert.equal(await t.agent.clickEl("D9"), changed("D9"));
  assert.equal(t.acts.length, 0);
});

test("click and type: refused until a do has handed back, and again once a later do has finished", async () => {
  const replies = [says("ask for help", 0.9, 0.1), says("step done", 0.9, 0.95)];
  const t = setup({ drex: () => replies.shift(), handedBack: false });
  // before any do
  assert.equal(await t.agent.clickEl("E1"), DREX_FIRST);
  assert.equal(await t.agent.typeEl("E1", "x", true), DREX_FIRST);
  assert.equal(t.acts.length, 0);
  assert.equal(t.looks.n, 0);
  assert.deepEqual(t.tab.keys, []);
  // a do that handed back: the LLM carries on by hand
  assert.match(await t.agent.doIntent("open it", "it is open", ""), /^DREX handed back: /);
  assert.equal(await t.agent.clickEl("E2"), view());
  assert.equal(await t.agent.typeEl("E1", "x", false), view());
  assert.equal(await t.agent.clickEl("E3"), view()); // as often as it needs
  assert.equal(t.acts.length, 3);
  // a later do that finished
  assert.match(await t.agent.doIntent("open it", "it is open", ""), /^DREX done /);
  assert.equal(await t.agent.clickEl("E2"), DREX_FIRST);
  assert.equal(await t.agent.typeEl("E1", "x", false), DREX_FIRST);
  assert.equal(t.acts.length, 3);
});

test("click: a do that stopped at its move cap counts as a hand back", async () => {
  const t = setup({ drex: [says("click E2", 0.9, 0.1)], handedBack: false });
  assert.equal((await t.agent.doIntent("open it", "it is open", "")).split("\n")[0], "DREX stopped after 6 moves");
  assert.equal(await t.agent.clickEl("E3"), view());
  assert.equal(t.acts.length, DO_MAX_MOVES + 1);
});

test("click: a click that was not made says why before the page", async () => {
  const t = setup({ outcome: { blocked: "repeated without progress" } });
  assert.equal(await t.agent.clickEl("E2"), `click not made: repeated without progress\n${view()}`);
});

test("type: the type move for the element is made as the LLM's own with the text, and the short view comes back", async () => {
  const t = setup();
  const result = await t.agent.typeEl("E1", "order 7", false);
  assert.equal(t.acts.length, 1);
  const [c] = t.acts;
  assert.equal(c.act.kind, "type");
  assert.equal(c.act.el.label, "E1");
  assert.deepEqual(c.act.text, { name: "typed", text: "order 7" });
  assert.equal(c.text, "order 7");
  assert.equal(c.who, "llm");
  assert.equal(c.p, undefined);
  assert.equal(c.note, "the LLM's own move");
  assert.deepEqual(c.opts, { prechecked: true, step: t.agent.plan.steps[0] });
  assert.equal(result, view());
  assert.equal(t.looks.n, 1);
  assert.deepEqual(t.tab.keys, []);
  assert.equal(t.tab.settles, 0);
});

test("type: with enter, Enter is pressed after the typing and the page settles; the move's screenshot is dropped", async () => {
  const t = setup();
  const act = t.agent.act;
  t.agent.act = async (...args) => {
    const r = await act(...args);
    t.agent.afterShot = { tabId: 1, jpeg: "typed", elements: null }; // what the real act leaves after a move
    t.tab.order = [...(t.tab.order ?? []), "act"];
    return r;
  };
  const key = t.tab.key;
  t.tab.key = async (name) => {
    t.tab.order = [...(t.tab.order ?? []), `key ${name}`];
    return key(name);
  };
  await t.agent.typeEl("E4", "3", true);
  assert.deepEqual(t.tab.keys, ["Enter"]);
  assert.deepEqual(t.tab.order, ["act", "key Enter"]);
  assert.equal(t.tab.settles, 1);
  assert.equal(t.agent.afterShot, null);
});

test("type: a read-only date field gets the LLM's own text, not the date the task names", async () => {
  const field = control("E6", "textbox", "Check-in", { readOnly: true });
  const t = setup({ Kind: switched.LoopAgent, els: [field], off: [], drex: [says("ask for help", 0.9, 0.1)] });
  t.agent.task = "Book the room for 2025-03-04";
  // not a date: the field has no type move for it, and the task's date is not typed in its place
  assert.equal(
    await t.agent.typeEl("E6", "next friday", false),
    "E6 is not a type target on this page; use page to see the controls",
  );
  assert.equal(t.acts.length, 0);
  // a date of its own is typed as the LLM wrote it
  await t.agent.typeEl("E6", "2026-01-02", false);
  assert.equal(t.acts.length, 1);
  assert.deepEqual(t.acts[0].act.text, { name: "typed", text: "2026-01-02" });
  assert.equal(t.acts[0].text, "2026-01-02");
  // Drex, in a do, is still offered the date the task names for such a field
  await t.agent.doIntent("set the check-in", "the check-in is set", "");
  assert.ok("type date into E6" in t.drexCalls[0].questions.move.criteria);
});

test("type: only an element that takes typing is a type target", async () => {
  const t = setup();
  const message = (el) => `${el} is not a type target on this page; use page to see the controls`;
  assert.equal(await t.agent.typeEl("E2", "x", false), message("E2")); // a link
  assert.equal(await t.agent.typeEl("E5", "x", true), message("E5")); // a select
  assert.equal(
    await t.agent.typeEl("E99", "x", false), // not on the page the LLM read
    `E99 changed since your last page view. The page now:\n${view()}`,
  );
  assert.equal(t.acts.length, 0);
  assert.deepEqual(t.tab.keys, []);
});

test("type: a typing that was not made presses no Enter, and says why before the page", async () => {
  const t = setup({ outcome: { blocked: "stale target" } });
  assert.equal(await t.agent.typeEl("E4", "3", true), `type not made: stale target\n${view()}`);
  assert.deepEqual(t.tab.keys, []);
  assert.equal(t.tab.settles, 0);
});

test("type: where the move itself presses Enter in a search box (searchEnter), the tool does not press it again", async () => {
  const t = setup({ Kind: textOnly.LoopAgent });
  await t.agent.typeEl("E1", "order 7", true); // a search box
  assert.deepEqual(t.tab.keys, []);
  assert.equal(t.tab.settles, 0);
  await t.agent.typeEl("E4", "3", true); // an ordinary field
  assert.deepEqual(t.tab.keys, ["Enter"]);
  assert.equal(t.tab.settles, 1);
});

test("do, click, type and check read the page as it is now, not the capture a move left before the LLM's turn", async () => {
  // the page changes while the LLM thinks (a preview opens when a text box loses focus): this capture shows what it was
  const stale = { tabId: 1, jpeg: "stale", elements: { els: [control("E1", "button", "Old")], off: [], vp: VIEWPORT } };
  const checked = { answers: { check: { noul: 0.5 } }, usage: {}, ms: 1, usd: 0 };
  const tools = {
    do: (t) => t.agent.doIntent("open it", "it is open", ""),
    click: (t) => t.agent.clickEl("E2"),
    type: (t) => t.agent.typeEl("E1", "x", false),
    check: (t) => t.agent.checkClaim("it is open"),
  };
  for (const [name, use] of Object.entries(tools)) {
    const t = setup({ drex: (call) => ("check" in call.questions ? checked : says("ask for help", 0.9, 0.1)) });
    t.agent.afterShot = { ...stale };
    await use(t);
    assert.deepEqual(t.looks.reused, [false], name);
    for (const a of t.acts) assert.equal(a.scr.els, t.tab.els, name); // the move was made on the page read just now
  }
});

test("look reads the page as it is now, not the capture a move left before the LLM's turn", async () => {
  const t = setup();
  t.agent.afterShot = { tabId: 1, jpeg: "stale", elements: null };
  await t.agent.runAction({ action: "look" });
  assert.deepEqual(t.looks.reused, [false]);
});

test("do: its first look reads the page afresh, and the capture each move leaves is the screen of the next look", async () => {
  const t = setup({ drex: [says("click E2", 0.9, 0.1), says("click E3", 0.9, 0.95)] });
  const act = t.agent.act;
  t.agent.act = async (...args) => {
    const r = await act(...args);
    // what the real act leaves after a move: the capture taken right after it
    t.agent.afterShot = { tabId: 1, jpeg: "after", elements: { els: t.tab.els, off: t.tab.off, vp: VIEWPORT } };
    return r;
  };
  t.agent.afterShot = { tabId: 1, jpeg: "stale", elements: { els: [], off: [], vp: VIEWPORT } };
  await t.agent.doIntent("open the orders page", "the order list is open", "");
  assert.deepEqual(t.looks.reused, [false, true]);
  assert.equal(t.tab.reads, 2); // the first look, and the view in the report: the second look read nothing
});

test("view: it records, for each control it lists, the role and the name that its line gives", async () => {
  const els = [
    control("E1", "textbox", "Search"),
    control("E2", "link", "Buy\n  now"),
    control("E3", "button", "x".repeat(100)),
    { label: "E4", text: "Cart", node: 4, box: [0, 0, 10, 10] }, // no name and no role: its text, and "control"
  ];
  const off = [control("D1", "link", "Reports", { dist: 1, where: "1 screen down" })];
  const t = setup({ els, off });
  await t.agent.view(SHORT_VIEW);
  assert.deepEqual(
    [...t.agent.viewLabels].map(([tag, { role, name }]) => [tag, { role, name }]),
    [
      ["E1", { role: "textbox", name: "Search" }],
      ["E2", { role: "link", name: "Buy now" }],
      ["E3", { role: "button", name: "x".repeat(80) }],
      ["E4", { role: "control", name: "Cart" }],
      ["D1", { role: "link", name: "Reports" }],
    ],
  );
  // the same role and name as the line that the LLM read
  for (const el of [...els, ...off]) {
    const { role, name } = t.agent.viewLabels.get(el.label);
    assert.ok(controlLine(el).startsWith(`${el.label} ${role} "${name}"`), controlLine(el));
  }
});

test("view: only the controls it lists are recorded, not the ones its limits leave out", async () => {
  const on = Array.from({ length: SHORT_VIEW.controls + 5 }, (_, i) => control(`E${i + 1}`, "link", `Item ${i + 1}`));
  const far = Array.from({ length: SHORT_VIEW.off + 3 }, (_, i) =>
    control(`D${i + 1}`, "link", `Far ${i + 1}`, { dist: 1, where: "1 screen down" }),
  );
  const t = setup({ els: on, off: far });
  const text = await t.agent.view(SHORT_VIEW);
  const listed = [...text.matchAll(/^([ED]\d+) /gm)].map((m) => m[1]);
  assert.equal(listed.length, SHORT_VIEW.controls + SHORT_VIEW.off);
  assert.deepEqual([...t.agent.viewLabels.keys()], listed);
  assert.ok(!t.agent.viewLabels.has(`E${SHORT_VIEW.controls + 1}`));
  assert.ok(!t.agent.viewLabels.has(`D${SHORT_VIEW.off + 1}`));
});

test("view: the record is of the last view; a view that failed leaves it as it was", async () => {
  const t = setup();
  await t.agent.view(SHORT_VIEW);
  const first = [...t.agent.viewLabels];
  const info = t.tab.info;
  t.tab.info = async () => {
    throw new Error("the page is gone");
  };
  t.tab.els = [control("E1", "link", "Home")]; // the page moved on, and the view of it fails
  t.tab.off = [];
  await assert.rejects(t.agent.view(SHORT_VIEW), /the page is gone/);
  assert.deepEqual([...t.agent.viewLabels], first);
  t.tab.info = info;
  await t.agent.view(SHORT_VIEW);
  assert.deepEqual(
    [...t.agent.viewLabels].map(([tag, { role, name }]) => [tag, { role, name }]),
    [["E1", { role: "link", name: "Home" }]],
  );
});

test("view: a page that fails to be read is read again, 3 times at most, with a pause of 600 ms before each", async (t) => {
  const delays = [];
  t.mock.method(globalThis, "setTimeout", (fn, ms) => {
    delays.push(ms);
    fn();
    return 0;
  });
  const s = setup();
  const elements = s.tab.elements;
  let calls = 0;
  let failing = 3;
  s.tab.elements = async () => {
    calls++;
    if (failing-- > 0) throw new Error("Execution context was destroyed");
    return elements();
  };
  assert.equal(await s.agent.view(SHORT_VIEW), view());
  assert.equal(calls, 4);
  assert.deepEqual(delays, [600, 600, 600]);
  // a fourth failure is the view's own
  calls = 0;
  failing = 4;
  delays.length = 0;
  await assert.rejects(s.agent.view(SHORT_VIEW), /Execution context was destroyed/);
  assert.equal(calls, 4);
  assert.equal(delays.length, 3);
});

test("view: a Stop is not read again", async () => {
  const s = setup();
  let calls = 0;
  s.tab.elements = async () => {
    calls++;
    s.agent.stop();
    throw new Error("the debugger is gone");
  };
  await assert.rejects(s.agent.view(SHORT_VIEW), /the debugger is gone/);
  assert.equal(calls, 1);
});

test("do: a page still loading when the do ends is read again, so a finished do stays finished", async () => {
  const s = setup({ drex: [says("click E2", 0.9, 0.1), says("click E2", 0.9, 0.95)] });
  s.agent.viewPauseMs = 0;
  const elements = s.tab.elements;
  let calls = 0;
  s.tab.elements = async () => {
    if (++calls === 3) throw new Error("Execution context was destroyed"); // the view that ends the report
    return elements();
  };
  const result = await s.agent.doIntent("open the orders page", "the order list is open", "");
  assert.equal(
    result,
    [
      "DREX done (95% sure: the order list is open)",
      fenced("MOVES:\n1. clicked link 'Orders' -> the screen changed"),
      "PAGE NOW:",
      view(),
    ].join("\n"),
  );
  assert.equal(calls, 4); // the two looks, the view that failed, and the view again
});

test("do: a page that cannot be read at its end does not undo the do: the report says so", async () => {
  const cases = [
    [[says("click E2", 0.9, 0.1), says("click E2", 0.9, 0.95)], /^DREX done \(95% sure: it is open\)$/, false],
    [[says("ask for help", 0.9, 0.1)], /^DREX handed back: /, true],
  ];
  for (const [replies, first, handedBack] of cases) {
    const s = setup({ drex: replies, handedBack: false });
    s.agent.viewPauseMs = 0;
    const elements = s.tab.elements;
    let calls = 0;
    s.tab.elements = async () => {
      if (++calls > replies.length) throw new Error("Execution context was destroyed"); // each look reads once
      return elements();
    };
    const result = await s.agent.doIntent("open it", "it is open", "");
    assert.match(result.split("\n")[0], first);
    assert.match(result, /\nPAGE NOW:\n\(the page could not be read: Execution context was destroyed\)$/);
    assert.equal(s.agent.handedBack, handedBack);
  }
});

// What the LLM read in ELS: the link "Orders" is E2 and the box "Quantity" is E4. By the time it acts on a tag the page
// may have moved on. These are such pages, and the control that the tag then means (none: the LLM is told it changed).
const STATUS = control("E4", "combobox", "Status", { select: true, options: ["Open", "Complete"], selectedIndex: 0 });
const SEARCH = control("E1", "textbox", "Search", { field: true });
const FAR = { dist: 1, where: "1 screen up" };
// a preview opened above the link: one more control before it
const MOVED = [
  SEARCH,
  control("E2", "button", "Preview"),
  control("E3", "link", "Orders", { node: 2 }),
  control("E4", "button", "Apply", { node: 3 }),
  control("E5", "textbox", "Quantity", { node: 4, field: true }),
  control("E6", "combobox", "Status", { node: 5, select: true, options: ["Open", "Complete"], selectedIndex: 0 }),
];
const MOVED_PAGES = {
  "nothing moved": { els: ELS, off: OFF, click: "E2" },
  "a control was added above it": { els: MOVED, off: OFF, click: "E3" },
  "it scrolled off the screen": {
    els: [SEARCH, control("E2", "button", "Apply"), control("E3", "textbox", "Quantity", { field: true }), STATUS],
    off: [control("D1", "link", "Orders", { ...FAR, node: 2 })],
    click: "D1",
  },
  "its label holds it still, and another one has the same name": {
    els: [SEARCH, control("E2", "link", "Orders"), control("E3", "button", "Apply"), control("E4", "link", "Orders")],
    off: [],
    click: "E2",
  },
  "it is gone": {
    els: [SEARCH, control("E2", "button", "Apply"), control("E3", "textbox", "Quantity", { field: true }), STATUS],
    off: [control("D1", "link", "Reports", FAR)],
  },
  "two have its name, and its label holds neither": {
    els: [SEARCH, control("E2", "button", "Preview"), control("E3", "link", "Orders"), control("E4", "link", "Orders")],
    off: [],
  },
  "a control of that name has another role": { els: [SEARCH, control("E2", "button", "Orders")], off: [] },
  "it is called something else": { els: [SEARCH, control("E2", "link", "Orders (3)")], off: [] },
};

test("click: a tag is the control the last view showed under it, found again when the page has moved on", async () => {
  for (const [name, { els, off, click }] of Object.entries(MOVED_PAGES)) {
    const t = setup();
    await t.agent.view(SHORT_VIEW); // the LLM read ELS: E2 is the link "Orders"
    t.tab.els = els;
    t.tab.off = off;
    const result = await t.agent.clickEl("E2");
    if (click) {
      assert.equal(t.acts.length, 1, name);
      assert.equal(t.acts[0].act.el.label, click, name);
      assert.equal(t.acts[0].act.el.name, "Orders", name);
      assert.equal(result, view(els, off), name);
    } else {
      assert.equal(t.acts.length, 0, name);
      assert.equal(result, `E2 changed since your last page view. The page now:\n${view(els, off)}`, name);
    }
  }
});

test("click: a tag that is gone says so with the page now, and the tags of that page are the ones that count after it", async () => {
  const t = setup();
  await t.agent.view(SHORT_VIEW);
  t.tab.els = [SEARCH, control("E2", "button", "Preview")];
  t.tab.off = [];
  assert.match(
    await t.agent.clickEl("E2"),
    new RegExp(`^E2 changed since your last page view\\. The page now:\\n<page-data id="${NONCE}">\\nPAGE: "Orders"`),
  );
  assert.equal(t.acts.length, 0);
  assert.equal(t.looks.n, 1);
  // the LLM read that answer, in which E2 is the Preview button
  await t.agent.clickEl("E2");
  assert.deepEqual(
    t.acts.map((a) => a.act.el.name),
    ["Preview"],
  );
});

test("click and type: a tag the last view did not list is not acted on: the LLM is told it changed, with the page now", async () => {
  const on = Array.from({ length: SHORT_VIEW.controls + 5 }, (_, i) => control(`E${i + 1}`, "link", `Item ${i + 1}`));
  const t = setup({ els: on, off: [] });
  await t.agent.view(SHORT_VIEW); // lists the first SHORT_VIEW.controls controls
  const beyond = `E${SHORT_VIEW.controls + 2}`;
  const changed = `${beyond} changed since your last page view. The page now:\n${view(on, [])}`;
  assert.equal(await t.agent.clickEl(beyond), changed);
  assert.equal(await t.agent.typeEl(beyond, "x", true), changed);
  assert.equal(t.acts.length, 0);
  assert.deepEqual(t.tab.keys, []);
  // no view at all is no tag listed either
  const first = setup({ seen: false });
  assert.equal(await first.agent.clickEl("E3"), `E3 changed since your last page view. The page now:\n${view()}`);
  assert.equal(first.acts.length, 0);
  // the page it showed lists the tags that count after it
  await first.agent.clickEl("E3");
  assert.equal(first.acts[0].act.el.name, "Apply");
});

test("click: a tag whose control takes no click is refused, not given to the control that has the label now", async () => {
  const t = setup();
  await t.agent.view(SHORT_VIEW); // the LLM read E5 as the select "Status"
  t.tab.els = [
    SEARCH,
    control("E2", "button", "Preview"),
    control("E3", "combobox", "Status", { node: 5, select: true, options: ["Open"], selectedIndex: 0 }),
    control("E4", "link", "Orders"),
    control("E5", "button", "Apply"),
  ];
  t.tab.off = [];
  assert.equal(await t.agent.clickEl("E5"), "E5 is not a click target on this page; use page to see the controls");
  assert.equal(t.acts.length, 0);
});

test("type: a tag is the control the last view showed under it, found again when the page has moved on", async () => {
  const pages = {
    "nothing moved": { els: ELS, off: OFF, type: "E4" },
    "a control was added above it": { els: MOVED, off: OFF, type: "E5" },
    "it is gone": {
      els: [SEARCH, control("E2", "link", "Orders"), control("E3", "button", "Apply"), STATUS],
      off: OFF,
    },
    "a field of that name is a button now": {
      els: [
        SEARCH,
        control("E2", "link", "Orders"),
        control("E3", "button", "Apply"),
        control("E4", "button", "Quantity"),
      ],
      off: OFF,
    },
  };
  for (const [name, { els, off, type }] of Object.entries(pages)) {
    const t = setup();
    await t.agent.view(SHORT_VIEW); // the LLM read ELS: E4 is the box "Quantity"
    t.tab.els = els;
    t.tab.off = off;
    const result = await t.agent.typeEl("E4", "3", true);
    if (type) {
      assert.deepEqual(
        t.acts.map((a) => [a.act.kind, a.act.el.label, a.text]),
        [["type", type, "3"]],
        name,
      );
      assert.deepEqual(t.tab.keys, ["Enter"], name);
      assert.equal(result, view(els, off), name);
    } else {
      assert.equal(t.acts.length, 0, name);
      assert.deepEqual(t.tab.keys, [], name); // no Enter into a control that was not the one
      assert.equal(result, `E4 changed since your last page view. The page now:\n${view(els, off)}`, name);
    }
  }
});

test("the five Drex actions reach their tools with the fields the LLM gave", async () => {
  const { agent } = setup();
  const calls = [];
  for (const name of ["doIntent", "clickEl", "typeEl", "pickRows", "checkClaim"])
    agent[name] = async (...args) => {
      calls.push([name, ...args]);
      return `${name} ran`;
    };
  const base = {
    thought: "",
    intent: "",
    expect: "",
    text: "",
    texts: [],
    url: "",
    urls: [],
    js: "",
    find: "",
    el: "",
    enter: false,
    rows: [],
    question: "",
    choices: [],
    claim: "",
    answer: "",
    outcome: "done",
  };
  const texts = [];
  for (const fields of [
    { action: "do", intent: "open it", expect: "it is open", text: "hi", texts: [{ field: "Title", text: "T" }] },
    { action: "click", el: "E2" },
    { action: "type", el: "E1", text: "x", enter: true },
    { action: "pick", rows: ["a", "b"], question: "q", choices: ["x", "y"] },
    { action: "check", claim: "c" },
  ])
    texts.push((await agent.runAction({ ...base, ...fields })).text);
  assert.deepEqual(texts, ["doIntent ran", "clickEl ran", "typeEl ran", "pickRows ran", "checkClaim ran"]);
  assert.deepEqual(calls, [
    ["doIntent", "open it", "it is open", "hi", [{ field: "Title", text: "T" }]],
    ["clickEl", "E2"],
    ["typeEl", "E1", "x", true],
    ["pickRows", ["a", "b"], "q", ["x", "y"]],
    ["checkClaim", "c"],
  ]);
});

test("click and type never replace a known target with a same-named peer", async (context) => {
  for (const action of ["click", "type"]) {
    for (const change of [
      "peer takes its label",
      "target label disappears",
      "unique target replaced",
      "node is unavailable",
    ]) {
      await context.test(`${action}: ${change}`, async () => {
        const field = action === "type";
        const role = field ? "textbox" : "button";
        const target = control("E3", role, "Repeated", { node: 303, field });
        const peer = control("E2", role, "Repeated", { node: 202, field });
        const before =
          change === "unique target replaced" || change === "node is unavailable" ? [target] : [peer, target];
        const t = setup({ els: before, off: [], seen: false });
        await t.agent.view(SHORT_VIEW);
        t.tab.els =
          change === "peer takes its label"
            ? [{ ...peer, label: "E3" }]
            : change === "target label disappears"
              ? [peer]
              : [{ ...target, node: change === "node is unavailable" ? undefined : 404 }];
        const answer = action === "click" ? await t.agent.clickEl("E3") : await t.agent.typeEl("E3", "chosen", true);
        assert.equal(t.acts.length, 0, `${action}: ${change} must not dispatch to another control`);
        assert.deepEqual(t.tab.keys, [], `${action}: ${change} must not press Enter`);
        assert.match(answer, /^E3 changed since your last page view\./);
      });
    }
  }
});

test("click and type follow the same known node when repeated controls exchange labels", async (context) => {
  for (const action of ["click", "type"]) {
    await context.test(action, async () => {
      const field = action === "type";
      const role = field ? "textbox" : "button";
      const target = control("E3", role, "Repeated", { node: 303, field });
      const peer = control("E2", role, "Repeated", { node: 202, field });
      const t = setup({ els: [peer, target], off: [], seen: false });
      await t.agent.view(SHORT_VIEW);
      t.tab.els = [
        { ...target, label: "E2" },
        { ...peer, label: "E3" },
      ];
      if (action === "click") await t.agent.clickEl("E3");
      else await t.agent.typeEl("E3", "chosen", true);
      assert.equal(t.acts.length, 1);
      assert.equal(t.acts[0].act.el.node, 303, `${action} must follow the original node, not its old display label`);
      assert.equal(t.acts[0].act.el.label, "E2");
      if (field) assert.equal(t.acts[0].text, "chosen");
    });
  }
});

test("a matching backend node number in another tab does not authorize a stale click", async () => {
  const t = setup({ seen: false });
  await t.agent.view(SHORT_VIEW);
  const other = { ...t.tab, id: 2 };
  t.agent.currentTab = async () => other;
  const answer = await t.agent.clickEl("E2");
  assert.equal(t.acts.length, 0);
  assert.match(answer, /^E2 changed since your last page view\./);
  // The denial delivered the new tab's public view; its fresh tags now belong to that tab.
  await t.agent.clickEl("E2");
  assert.equal(t.acts.length, 1);
  assert.equal(t.acts[0].tab.id, 2);
});

test("a multi-URL read invalidates old tags even when the restored page reuses node numbers", async () => {
  const t = setup({ seen: false });
  await t.agent.view(SHORT_VIEW);
  t.agent.trusted = new Set([new URL(START).origin]);
  const visits = [];
  t.tab.navigate = async (url) => {
    visits.push(url);
  };
  await t.agent.readPage({ js: "", find: "Total", urls: ["/other"] });
  assert.deepEqual(visits, ["https://shop.example/other", START]);
  const answer = await t.agent.clickEl("E2");
  assert.equal(t.acts.length, 0);
  assert.match(answer, /^E2 changed since your last page view\./);
  await t.agent.clickEl("E2");
  assert.equal(t.acts.length, 1);
  assert.equal(t.acts[0].act.el.node, 2);
});

test("a saved control without a backend node is refused even when a same-named control has none either", async (context) => {
  for (const action of ["click", "type"]) {
    await context.test(action, async () => {
      const field = action === "type";
      const el = control("E3", field ? "textbox" : "button", "Repeated", { field, node: undefined });
      const t = setup({ els: [el], off: [], seen: false });
      await t.agent.view(SHORT_VIEW);
      const answer = action === "click" ? await t.agent.clickEl("E3") : await t.agent.typeEl("E3", "x", true);
      assert.equal(t.acts.length, 0);
      assert.deepEqual(t.tab.keys, []);
      assert.match(answer, /^E3 changed since your last page view\./);
    });
  }
});

test("a matching backend node number in another tab does not authorize a stale type", async () => {
  const t = setup({ seen: false });
  await t.agent.view(SHORT_VIEW);
  const other = { ...t.tab, id: 2 };
  t.agent.currentTab = async () => other;
  const answer = await t.agent.typeEl("E1", "x", true);
  assert.equal(t.acts.length, 0);
  assert.deepEqual(t.tab.keys, []);
  assert.match(answer, /^E1 changed since your last page view\./);
});

test("a failed navigation still drops the old tags", async () => {
  const t = setup({ seen: false });
  await t.agent.view(SHORT_VIEW);
  t.tab.navigate = async () => {
    throw new Error("net::ERR_FAILED");
  };
  await assert.rejects(t.agent.visit(t.tab, START));
  const answer = await t.agent.clickEl("E2");
  assert.equal(t.acts.length, 0);
  assert.match(answer, /^E2 changed since your last page view\./);
});
