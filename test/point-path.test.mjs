import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { MAX_INPUT_POINTS, MAX_PATH_POINTS, pathFromHelper, samplePath } from "../src/gesture-path.ts";
import { rescueSchema, rescueSystem } from "../src/llm.ts";
import { Tab } from "../src/cdp.ts";

const surface = { w: 800, h: 600 };
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const closeTo = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} is not within ${eps} of ${b}`);

test("samplePath draws a whole ellipse from centre and radii: smooth, round and closed", () => {
  const pts = samplePath({ arc: { cx: 400, cy: 300, rx: 120, ry: 80, startDeg: 0, endDeg: 360 } }, surface);
  assert.ok(pts.length >= 24 && pts.length <= MAX_PATH_POINTS, `${pts.length} points`);
  // every sample is on the ellipse, and the stroke ends where it began
  for (const p of pts) closeTo(((p.x - 400) / 120) ** 2 + ((p.y - 300) / 80) ** 2, 1, 1e-9);
  assert.deepEqual(pts[pts.length - 1], pts[0]);
  // no gap between neighbours bigger than the sampling allows (the stroke looks continuous to the page)
  for (let i = 1; i < pts.length; i++) assert.ok(dist(pts[i - 1], pts[i]) < 30);
  // start and end angles missing: the same whole ellipse
  assert.deepEqual(samplePath({ arc: { cx: 400, cy: 300, rx: 120, ry: 80 } }, surface), pts);
  assert.deepEqual(
    samplePath({ arc: { cx: 400, cy: 300, rx: 120, ry: 80, startDeg: null, endDeg: null } }, surface),
    pts,
  );
});

test("samplePath: an arc runs from its start angle to its end angle, and closed joins its end to its start", () => {
  const spec = { cx: 300, cy: 300, rx: 100, ry: 100, startDeg: 0, endDeg: 90 };
  const open = samplePath({ arc: spec }, surface);
  closeTo(open[0].x, 400);
  closeTo(open[0].y, 300);
  closeTo(open[open.length - 1].x, 300);
  closeTo(open[open.length - 1].y, 400); // +y is down on screen: 90 degrees is straight down
  const shut = samplePath({ arc: { ...spec, closed: true } }, surface);
  assert.equal(shut.length, open.length + 1);
  assert.deepEqual(shut[shut.length - 1], shut[0]);
  // a negative sweep goes the other way round
  const back = samplePath({ arc: { ...spec, startDeg: 90, endDeg: 0 } }, surface);
  closeTo(back[0].y, 400);
  closeTo(back[back.length - 1].x, 400);
  // and the short way: the same quarter turn reversed, not three quarters round the other side
  assert.equal(back.length, open.length);
  const mid = back[Math.floor(back.length / 2)];
  assert.ok(mid.x > 300 && mid.y > 300, `midpoint ${mid.x},${mid.y} is not in the lower right quadrant`);
});

test("samplePath keeps a huge ellipse within the point budget, closed or not", () => {
  const big = { cx: 400, cy: 300, rx: 399, ry: 299 };
  assert.ok(samplePath({ arc: big }, surface).length <= MAX_PATH_POINTS);
  const near = samplePath({ arc: { ...big, startDeg: 0, endDeg: 350, closed: true } }, surface);
  assert.ok(near.length <= MAX_PATH_POINTS);
  assert.deepEqual(near[near.length - 1], near[0]);
});

test("samplePath densifies a polyline between its own vertices and never past the budget", () => {
  const pts = samplePath(
    {
      points: [
        { x: 10, y: 10 },
        { x: 110, y: 10 },
        { x: 110, y: 110 },
      ],
    },
    surface,
  );
  assert.deepEqual(pts[0], { x: 10, y: 10 });
  assert.deepEqual(pts[pts.length - 1], { x: 110, y: 110 });
  assert.ok(
    pts.some((p) => p.x === 110 && p.y === 10),
    "the corner stays",
  );
  for (let i = 1; i < pts.length; i++) assert.ok(dist(pts[i - 1], pts[i]) <= 6 + 1e-9);
  // a long zigzag of the most points allowed still fits
  const zig = Array.from({ length: MAX_INPUT_POINTS }, (_, i) => ({ x: i % 2 ? 790 : 5, y: 5 + i * 9 }));
  const dense = samplePath({ points: zig }, surface);
  assert.ok(dense.length <= MAX_PATH_POINTS && dense.length >= zig.length, `${dense.length} points`);
  const closed = samplePath({ points: zig, closed: true }, surface);
  assert.ok(closed.length <= MAX_PATH_POINTS);
  assert.deepEqual(closed[closed.length - 1], closed[0]);
});

test("samplePath closes a polyline that asks for it, once", () => {
  const tri = [
    { x: 10, y: 10 },
    { x: 60, y: 10 },
    { x: 10, y: 60 },
  ];
  const shut = samplePath({ points: tri, closed: true }, surface);
  assert.deepEqual(shut[shut.length - 1], { x: 10, y: 10 });
  const already = samplePath({ points: [...tri, { x: 10, y: 10 }], closed: true }, surface);
  assert.deepEqual(already, shut);
});

test("samplePath refuses what is not a finite stroke inside the page", () => {
  const ok = { arc: { cx: 400, cy: 300, rx: 50, ry: 50 } };
  assert.ok(samplePath(ok, surface).length);
  const refused = (path, what, pattern = /Invalid path/) =>
    assert.throws(() => samplePath(path, surface), pattern, what);
  refused(undefined, "no path");
  refused({}, "neither points nor arc");
  refused({ points: [], arc: null }, "an empty list is no polyline");
  refused(
    {
      ...ok,
      points: [
        { x: 1, y: 1 },
        { x: 5, y: 5 },
      ],
    },
    "both given",
  );
  for (const bad of [NaN, Infinity, -Infinity, null, undefined, "10", true, {}])
    refused({ arc: { ...ok.arc, cx: bad } }, `cx ${String(bad)}`);
  refused({ arc: { ...ok.arc, ry: 0 } }, "a radius too small");
  refused({ arc: { ...ok.arc, rx: -50 } }, "a negative radius");
  refused({ arc: { ...ok.arc, startDeg: NaN } }, "a NaN angle");
  refused({ arc: { ...ok.arc, startDeg: "0" } }, "a string angle");
  refused({ arc: { ...ok.arc, startDeg: 10, endDeg: 10 } }, "no sweep");
  refused({ arc: { ...ok.arc, startDeg: 0, endDeg: 720 } }, "more than a turn");
  refused({ arc: { ...ok.arc, closed: "yes" } }, "a closed that is not a boolean");
  refused({ arc: { cx: 10, cy: 300, rx: 50, ry: 50 } }, "an ellipse that leaves the page");
  refused({ arc: 5 }, "arc not an object");
  refused({ points: [{ x: 1, y: 1 }] }, "one point");
  refused(
    {
      points: [
        { x: 1, y: 1 },
        { x: NaN, y: 2 },
      ],
    },
    "NaN point",
  );
  refused(
    {
      points: [
        { x: 1, y: 1 },
        { x: null, y: 2 },
      ],
    },
    "a null is not 0",
  );
  refused({ points: [{ x: 1, y: 1 }, { x: 2 }] }, "a missing y is not 0");
  refused({ points: [{ x: 1, y: 1 }, null] }, "a null point");
  refused(
    {
      points: [
        { x: 1, y: 1 },
        { x: 800, y: 2 },
      ],
    },
    "outside on the right",
  );
  refused(
    {
      points: [
        { x: 1, y: 1 },
        { x: -1, y: 2 },
      ],
    },
    "outside on the left",
  );
  refused(
    {
      points: [
        { x: 5, y: 5 },
        { x: 5, y: 5 },
      ],
    },
    "no extent",
  );
  refused({ points: Array.from({ length: MAX_INPUT_POINTS + 1 }, (_, i) => ({ x: i, y: i })) }, "too many", /too many/);
  refused(
    {
      points: [
        { x: 1, y: 1 },
        { x: 9, y: 9 },
      ],
      closed: 1,
    },
    "closed 1",
  );
  assert.throws(() => samplePath(ok, { w: NaN, h: 600 }), /no visible area/);
});

test("pathFromHelper converts screenshot pixels to CSS once, keeps angles and flags, and refuses non-numbers", () => {
  const poly = pathFromHelper(
    {
      points: [
        { x: 20, y: 40 },
        { x: 60, y: 80 },
      ],
      arc: [],
      closed: true,
    },
    2,
  );
  assert.deepEqual(poly, {
    points: [
      { x: 10, y: 20 },
      { x: 30, y: 40 },
    ],
    closed: true,
  });
  const arc = pathFromHelper(
    {
      points: [],
      arc: [{ cx: 200, cy: 100, rx: 60, ry: 40, startDeg: 10, endDeg: 200, closed: false }],
      closed: false,
    },
    2,
  );
  assert.deepEqual(arc, { arc: { cx: 100, cy: 50, rx: 30, ry: 20, startDeg: 10, endDeg: 200, closed: false } });
  const refused = (raw, scale = 2) => assert.throws(() => pathFromHelper(raw, scale), /Invalid path/);
  refused(null);
  refused({ points: [], arc: [] });
  refused({
    points: [
      { x: 1, y: 1 },
      { x: 2, y: 2 },
    ],
    arc: [{ cx: 1, cy: 1, rx: 5, ry: 5 }],
  });
  refused({
    points: [],
    arc: [
      { cx: 1, cy: 1, rx: 5, ry: 5 },
      { cx: 2, cy: 2, rx: 5, ry: 5 },
    ],
  });
  refused({
    points: [
      { x: null, y: 1 },
      { x: 2, y: 2 },
    ],
  });
  refused({ points: [], arc: [{ cx: "1", cy: 1, rx: 5, ry: 5 }] });
  refused(
    {
      points: [
        { x: 1, y: 1 },
        { x: 2, y: 2 },
      ],
    },
    0,
  );
  refused(
    {
      points: [
        { x: 1, y: 1 },
        { x: 2, y: 2 },
      ],
    },
    NaN,
  );
  // converted once: sampling the result against the CSS viewport is what the browser does next
  assert.ok(samplePath(arc, { w: 400, h: 300 }).length);
});

test("the helper's gesture schema and prompt are unchanged with the switch off", () => {
  const off = rescueSchema(["a"], true, false, true);
  const gesture = off.properties.gesture;
  assert.deepEqual(gesture.properties.kind.enum, ["hover", "double_click", "drag", "keychord", "drag_to"]);
  assert.deepEqual(gesture.required, ["kind", "endX", "endY", "key", "modifiers", "from", "to"]);
  assert.equal("path" in gesture.properties, false);
  assert.deepEqual(rescueSchema(["a"], true, false, true, false), off);
  assert.equal(rescueSystem(true, false, true).includes("path"), false);
  assert.equal(rescueSystem(true, false, true, false), rescueSystem(true, false, true));
  const plain = rescueSchema(["a"]).properties.gesture;
  assert.deepEqual(plain.properties.kind.enum, ["hover", "double_click", "drag", "keychord"]);
  assert.deepEqual(plain.required, ["kind", "endX", "endY", "key", "modifiers"]);
  // on: the path kind and a strict, fully required path object appear, and nothing else moves
  const on = rescueSchema(["a"], true, false, true, true).properties.gesture;
  assert.deepEqual(on.properties.kind.enum, [...gesture.properties.kind.enum, "path"]);
  assert.deepEqual(on.required, [...gesture.required, "path"]);
  assert.deepEqual(on.properties.path.required, ["points", "arc", "closed"]);
  assert.equal(on.properties.path.additionalProperties, false);
  assert.ok(rescueSystem(true, false, true, true).includes("gesture.path"));
});

function fakeTab(viewport = { w: 800, h: 600 }, failAt = Infinity) {
  const tab = new Tab(7);
  const events = [];
  tab.viewport = async () => viewport;
  tab.send = async (method, params) => {
    if (method !== "Input.dispatchMouseEvent") throw new Error(`unexpected ${method}`);
    events.push(params);
    if (events.length === failAt) throw new Error("the page went away");
    return {};
  };
  return { tab, events };
}

test("Tab.gesture draws a path: move there, press once, follow it with the button held, release at the end", async () => {
  const { tab, events } = fakeTab();
  const path = { arc: { cx: 400, cy: 300, rx: 100, ry: 100, startDeg: 0, endDeg: 360 } };
  const result = await tab.gesture({ kind: "path", path });
  const points = samplePath(path, surface);
  assert.equal(events[0].type, "mouseMoved");
  assert.equal(events[0].buttons, 0);
  assert.deepEqual([events[0].x, events[0].y], [points[0].x, points[0].y]);
  assert.deepEqual(
    events.map((e) => e.type),
    ["mouseMoved", "mousePressed", ...points.slice(1).map(() => "mouseMoved"), "mouseReleased"],
  );
  assert.equal(events.filter((e) => e.type === "mousePressed").length, 1);
  assert.ok(events.slice(2, -1).every((e) => e.buttons === 1));
  const last = events[events.length - 1];
  assert.deepEqual([last.x, last.y, last.buttons], [points[points.length - 1].x, points[points.length - 1].y, 0]);
  assert.deepEqual([result.kind, result.steps, result.released], ["path", points.length, true]);
});

test("Tab.gesture releases the button when a move fails mid-stroke, and sends nothing for a bad path", async () => {
  const { tab, events } = fakeTab({ w: 800, h: 600 }, 6);
  await assert.rejects(
    tab.gesture({
      kind: "path",
      path: {
        points: [
          { x: 10, y: 10 },
          { x: 300, y: 300 },
        ],
      },
    }),
    /page went away/,
  );
  assert.equal(events[events.length - 1].type, "mouseReleased");
  assert.equal(events.filter((e) => e.type === "mousePressed").length, 1);
  const bad = fakeTab({ w: 200, h: 200 });
  await assert.rejects(
    bad.tab.gesture({ kind: "path", path: { arc: { cx: 150, cy: 100, rx: 80, ry: 50 } } }),
    /Invalid path/,
  );
  await assert.rejects(bad.tab.gesture({ kind: "path" }), /Invalid path/);
  await assert.rejects(
    bad.tab.gesture({
      kind: "path",
      path: {
        points: [
          { x: 1, y: 1 },
          { x: 9, y: 9 },
        ],
      },
      modifiers: ["Shift"],
    }),
    /modifiers/,
  );
  assert.deepEqual(bad.events, []);
});

test("a straight drag still presses at its start, moves in 12 steps and releases at its end", async () => {
  const { tab, events } = fakeTab();
  await tab.gesture({ kind: "drag", x: 10, y: 20, endX: 130, endY: 140 });
  assert.deepEqual(
    events.map((e) => e.type),
    ["mouseMoved", "mousePressed", ...Array(12).fill("mouseMoved"), "mouseReleased"],
  );
  assert.deepEqual([events[1].x, events[1].y], [10, 20]);
  const last = events[events.length - 1];
  assert.deepEqual([last.x, last.y], [130, 140]);
});

// the switch is build-time (src/accuracy.ts), so the agent is built twice, as controller.test.mjs does
const buildAgent = async (acc) => {
  const dir = await mkdtemp(join(tmpdir(), "drex-point-path-"));
  await build({
    entryPoints: [resolve("src/agent.ts")],
    outdir: dir,
    bundle: true,
    platform: "node",
    format: "esm",
    packages: "external",
    define: { __DREX_ACC__: JSON.stringify(acc) },
  });
  const { Agent } = await import(pathToFileURL(join(dir, "agent.js")));
  await rm(dir, { recursive: true, force: true });
  return Agent;
};
const helperAgent = (Agent, gesture) => {
  const asked = [];
  const llm = {
    rescue: async (args) => {
      asked.push(args);
      return {
        json: { decision: "gesture", why: "draw", x: 0, y: 0, gesture },
        text: "",
        usd: 0,
        ms: 1,
        model: "fixture",
      };
    },
  };
  const a = new Agent({ drex: {}, llm, emit() {} });
  a.t0 = performance.now();
  a.task = "Draw the shape";
  a.index = 0;
  a.windowTabs = async () => [];
  return { a, asked };
};
const image = "data:image/png;base64,aQ==";
const scr = { img1: image, img2: image, els: [], info: { title: "", url: "" }, thumb: "", shot: { scale: 2 } };
const circle = {
  kind: "path",
  endX: 0,
  endY: 0,
  key: "",
  modifiers: [],
  path: {
    points: [],
    arc: [{ cx: 400, cy: 300, rx: 200, ry: 100, startDeg: 0, endDeg: 360, closed: true }],
    closed: false,
  },
};

test("with pointerPath on the helper asks for paths, and the agent converts original pixels to CSS exactly once", async () => {
  const Agent = await buildAgent("pointerPath");
  const { a, asked } = helperAgent(Agent, circle);
  const r = await a.rescue("draw", "state", scr, {}, {}, []);
  assert.equal(asked[0].pointerPath, true);
  assert.deepEqual(r.act, {
    kind: "gesture",
    gesture: {
      kind: "path",
      path: { arc: { cx: 200, cy: 150, rx: 100, ry: 50, startDeg: 0, endDeg: 360, closed: true } },
    },
  });
  let dispatched;
  await a.perform({ gesture: async (spec) => void (dispatched = spec) }, r.act);
  assert.deepEqual(dispatched, r.act.gesture);
  // a path the page cannot take is refused before it is dispatched
  const bad = helperAgent(Agent, {
    ...circle,
    path: { points: [], arc: [{ ...circle.path.arc[0], rx: null }], closed: false },
  });
  await assert.rejects(bad.a.rescue("draw", "state", scr, {}, {}, []), /Invalid path/);
});

test("with pointerPath off the helper is not offered paths and a path gesture is refused", async () => {
  const Agent = await buildAgent("dragTo");
  const { a, asked } = helperAgent(Agent, circle);
  await assert.rejects(a.rescue("draw", "state", scr, {}, {}, []), /Invalid helper gesture/);
  assert.equal(asked[0].pointerPath, false);
});
