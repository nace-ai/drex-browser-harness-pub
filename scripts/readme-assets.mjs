// Renders the README's images into docs/assets/ from docs/assets/src/benchmarks.json, in the Drex console's look (warm
// monochrome, Inter and Geist Mono, square corners, 1 px hairlines; see src/sidepanel.css). Run it after the numbers
// change: node scripts/readme-assets.mjs. It needs Playwright's Chromium once: node runner/bin/nace-browser.mjs install.
import { readFile } from "node:fs/promises";
import { chromium } from "playwright";

const root = new URL("../", import.meta.url);
const file = (path) => readFile(new URL(path, root));
const dataUrl = async (path, type) => `data:${type};base64,${(await file(path)).toString("base64")}`;

const data = JSON.parse((await file("docs/assets/src/benchmarks.json")).toString());
const fonts = {
  inter: await dataUrl("src/fonts/InterVariable.woff2", "font/woff2"),
  mono: await dataUrl("src/fonts/GeistMonoVariable.woff2", "font/woff2"),
};
const logos = {
  light: await dataUrl("src/brand/nace-logo-black.svg", "image/svg+xml"),
  dark: await dataUrl("src/brand/nace-logo-white.svg", "image/svg+xml"),
};

// The console's stone tokens. Context marks are dark enough to see on the card (the validator's contrast check), and
// every mark carries its value as text, so nothing is told by colour alone.
const THEMES = {
  light: {
    card: "#fafaf9",
    text: "#0c0a09",
    muted: "#78716c",
    line: "#e7e5e4",
    cell: "#f0efed",
    context: "#a8a29e",
    ink: "#1c1917",
    onInk: "#fafaf9",
    onInkMuted: "#d6d3d1",
    good: "#468e22",
  },
  dark: {
    card: "#1c1917",
    text: "#fafaf9",
    muted: "#a8a29e",
    line: "#3a3532",
    cell: "#292524",
    context: "#78716c",
    ink: "#f5f5f4",
    onInk: "#1c1917",
    onInkMuted: "#57534e",
    good: "#57a52c",
  },
};

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const pct = (r) => `${String(Math.round((100 * r.passed) / r.attempts))}%`;
const usd = (r) => (r.usd === undefined ? "" : `$${r.usd < 0.01 ? r.usd.toFixed(4) : r.usd.toFixed(3)}`);
const agentLabel = (a) => `${a.name} + ${a.model.replace(/^Claude /, "")}`;

function page(theme, body, css) {
  const t = THEMES[theme];
  return `<!doctype html><html><head><meta charset="utf-8"><style>
@font-face { font-family: Inter; src: url(${fonts.inter}) format("woff2"); font-weight: 100 900; }
@font-face { font-family: "Geist Mono"; src: url(${fonts.mono}) format("woff2"); font-weight: 100 900; }
:root { ${Object.entries(t)
    .map(([k, v]) => `--${k}: ${v};`)
    .join(" ")} }
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { background: transparent; }
body { font-family: Inter, sans-serif; color: var(--text); -webkit-font-smoothing: antialiased; font-optical-sizing: auto; }
.frame { display: inline-block; }
.card { background: var(--card); border: 1px solid var(--line); }
.mono { font-family: "Geist Mono", monospace; }
.label { font-family: "Geist Mono", monospace; font-size: 12px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); }
${css}
</style></head><body><div class="frame">${body}</div></body></html>`;
}

function header(theme, layout) {
  const bench = data.benchmarks.find((b) => b.id === "webarena-dev");
  const rows = data.agents
    .map((a) => ({ a, r: bench.results[a.id] }))
    .sort((x, y) => Number(x.a.ours === true) - Number(y.a.ours === true) || y.r.usd - x.r.usd);
  const max = Math.max(...rows.map(({ r }) => r.usd));
  const width = layout === "wide" ? 200 : 300;
  const bars = rows
    .map(
      ({ a, r }) => `<div class="row${a.ours ? " ours" : ""}">
  <div class="name">${esc(a.ours ? a.name : agentLabel(a))}</div>
  <div class="track"><div class="bar" style="width:${String(Math.max(4, Math.round((width * r.usd) / max)))}px"></div>
  <span class="val mono">${r.usdRange ? "~" : ""}${usd(r)}</span><span class="pass mono">${pct(r)}</span></div>
</div>`,
    )
    .join("");
  const css = `
.head { display: grid; align-items: center; }
.wide { width: 1200px; height: 400px; grid-template-columns: 470px 1fr; gap: 40px; padding: 0 56px 0 64px; }
.narrow { width: 800px; padding: 56px 56px 48px; }
.by { display: flex; align-items: center; gap: 10px; }
.by img { height: 22px; }
h1 { font-size: 66px; font-weight: 640; letter-spacing: -0.04em; line-height: 1; margin: 22px 0 26px; }
.tag { font-size: 18px; line-height: 1.65; color: var(--muted); }
.narrow .chart { margin-top: 44px; }
.rows { margin: 18px 0 20px; display: grid; gap: 8px; }
.row { display: grid; grid-template-columns: 196px 1fr; gap: 16px; align-items: center; height: 30px; }
.name { text-align: right; font-size: 15px; color: var(--muted); white-space: nowrap; }
.ours .name { color: var(--text); font-weight: 650; }
.track { display: flex; align-items: center; gap: 10px; }
.bar { height: 22px; background: var(--context); border-radius: 0 3px 3px 0; }
.ours .bar { background: var(--ink); }
.val { font-size: 14px; color: var(--text); }
.ours .val { font-weight: 650; }
.pass { font-size: 13px; color: var(--muted); }
.cap { font-size: 12.5px; line-height: 1.6; color: var(--muted); }`;
  return page(
    theme,
    `<div class="card head ${layout}">
  <div class="intro">
    <div class="by"><img src="${logos[theme]}" alt=""><span class="label">nace.ai</span></div>
    <h1>Drex Browser</h1>
    <p class="tag mono">Browser tasks in plain words,<br>for a fraction of a cent a move.</p>
  </div>
  <div class="chart">
    <div class="label">Model cost per task · lower is better</div>
    <div class="rows">${bars}</div>
    <p class="cap mono">${esc(bench.name)} ${esc(bench.detail)} <br>cost, then pass rate · model API list prices · October 2026</p>
  </div>
</div>`,
    css,
  );
}

function benchmarks(theme) {
  const head = data.agents
    .map((a) => `<th class="agent${a.ours ? " ours" : ""}"><b>${esc(a.name)}</b><span>${esc(a.model)}</span></th>`)
    .join("");
  const body = data.benchmarks
    .map((b) => {
      const rates = Object.values(b.results).map((r) => r.passed / r.attempts);
      const best = Math.max(...rates);
      const cells = data.agents
        .map((a) => {
          const r = b.results[a.id];
          if (!r) return `<td class="cell none"><div class="pct">—</div><div class="sub mono">not run</div></td>`;
          const top = r.passed / r.attempts === best ? '<i class="best"></i>' : "";
          // a pass rate and a cost read the same for every agent; how many times each ran a task is in docs/evals.md
          const cost = r.usd === undefined ? "cost not measured" : `${r.usdRange ? "~" : ""}${usd(r)} per task`;
          return `<td class="cell${a.ours ? " ours" : ""}"><div class="pct mono">${top}${pct(r)}</div>
<div class="sub mono">${cost}</div></td>`;
        })
        .join("");
      return `<tr><th class="bench"><b>${esc(b.name)}</b><span>${esc(b.detail)}</span></th>${cells}</tr>`;
    })
    .join("");
  const css = `
.wrap { width: 1200px; padding: 40px 40px 32px; }
h2 { font-size: 26px; font-weight: 640; letter-spacing: -0.02em; margin-bottom: 8px; }
table { border-collapse: separate; border-spacing: 6px; margin: 22px -6px 18px; table-layout: fixed; width: calc(100% + 12px); }
th, td { text-align: left; vertical-align: middle; }
th.agent { padding: 0 16px 6px; font-size: 14px; vertical-align: bottom; }
th.agent b, th.bench b { display: block; font-weight: 650; }
th.agent span, th.bench span { display: block; font-weight: 400; color: var(--muted); font-size: 13px; margin-top: 3px; }
th.agent.ours b { color: var(--text); }
th.bench { width: 228px; padding-right: 10px; font-size: 15px; }
.cell { background: var(--cell); padding: 14px 16px; height: 82px; }
.cell.ours { background: var(--ink); color: var(--onInk); }
.pct { font-size: 27px; font-weight: 500; letter-spacing: -0.02em; display: flex; align-items: center; gap: 8px; }
.sub { font-size: 12.5px; color: var(--muted); margin-top: 6px; }
.ours .sub { color: var(--onInkMuted); }
.none .pct { color: var(--muted); }
.best { width: 9px; height: 9px; background: var(--good); display: inline-block; }
.foot { font-size: 12.5px; line-height: 1.6; color: var(--muted); }`;
  return page(
    theme,
    `<div class="card wrap">
  <h2>Drex Browser and coding agents that drive a browser</h2>
  <div class="label">Pass rate · model cost per task · same tasks, graders and machine · October 2026</div>
  <table><thead><tr><th></th>${head}</tr></thead><tbody>${body}</tbody></table>
  <p class="foot mono"><i class="best"></i>&nbsp; highest pass rate in the row · — not run · Drex Browser has the lowest cost in every row<br>
  cost: model API list prices; coding agents ran on subscriptions and are priced from their tokens · details: docs/evals.md</p>
</div>`,
    css,
  );
}

function howItWorks(theme) {
  const options = [
    ["combobox", "Search", "3%"],
    ["link", "My Orders", "94%"],
    ["link", "My Wish List", "2%"],
    ["button", "Add to Cart", "1%"],
  ]
    .map(
      ([role, name, p], i) =>
        `<div class="opt${i === 1 ? " pick" : ""}"><span class="mono"><em>${role}</em> “${name}”</span><b class="mono">${p}</b></div>`,
    )
    .join("");
  const card = (label, title, text, viz, foot) => `<div class="card small">
  <div class="label">${label}</div><h4>${title}</h4><p>${text}</p><div class="viz">${viz}</div><div class="label foot">${foot}</div>
</div>`;
  const plan = [
    ["1", "browse", "Search for “1 TB SSD”"],
    ["2", "collect", "Price of every result"],
    ["3", "read", "Cheapest: name and price"],
  ]
    .map(([n, kind, goal]) => `<div class="step mono"><b>${n}</b><em>${kind}</em><span>${goal}</span></div>`)
    .join("");
  const approval = `<div class="ask"><div class="mono q">Allow this click?</div><div class="what">button “Place order”</div>
<div class="btns"><span class="btn mono">Stop</span><span class="btn mono">Allow once</span></div></div>`;
  const ways = [
    ["nace-browser mcp", "coding agents"],
    ["nace-browser run --json", "scripts"],
    ["Chrome side panel", "people"],
    ["Cloud runs", "apps · later"],
  ]
    .map(([w, who]) => `<span class="chip mono">${w}<em>${who}</em></span>`)
    .join("");
  const css = `
.hiw { width: 1200px; display: grid; gap: 16px; }
.big { display: grid; grid-template-columns: 1fr 470px; gap: 48px; align-items: center; padding: 36px 40px; }
h3 { font-size: 28px; font-weight: 640; letter-spacing: -0.02em; margin: 12px 0 12px; }
h4 { font-size: 20px; font-weight: 640; letter-spacing: -0.015em; margin: 12px 0 10px; }
p { font-size: 15.5px; line-height: 1.6; color: var(--muted); }
.opts { display: grid; gap: 6px; }
.opt { display: flex; justify-content: space-between; align-items: center; padding: 9px 14px; border: 1px solid var(--line); font-size: 14px; }
.opt em, .step em { font-style: normal; color: var(--muted); margin-right: 6px; }
.opt b { font-weight: 500; color: var(--muted); }
.opt.pick { background: var(--ink); color: var(--onInk); border-color: var(--ink); }
.opt.pick em, .opt.pick b { color: var(--onInkMuted); }
.opt.pick b { color: var(--onInk); }
.vcap { margin-top: 12px; text-align: right; }
.three { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; }
.small { padding: 28px 28px 22px; display: flex; flex-direction: column; }
.small p { min-height: 100px; }
.viz { margin: 18px 0 20px; flex: 1; display: flex; flex-direction: column; justify-content: center; gap: 6px; }
.step { display: grid; grid-template-columns: 18px 64px 1fr; font-size: 13px; padding: 8px 10px; border: 1px solid var(--line); }
.step b { font-weight: 500; color: var(--muted); }
.ask { border: 1px solid var(--line); padding: 14px 16px; }
.ask .q { font-size: 12px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.08em; }
.ask .what { font-size: 15px; font-weight: 600; margin: 8px 0 12px; }
.btns { display: flex; gap: 8px; }
.btn { font-size: 13px; padding: 6px 12px; border: 1px solid var(--line); }
.btn:last-child { background: var(--ink); color: var(--onInk); border-color: var(--ink); }
.ways { display: grid; gap: 6px; }
.chip { display: flex; justify-content: space-between; font-size: 13px; padding: 7px 10px; border: 1px solid var(--line); }
.chip em { font-style: normal; color: var(--muted); }
.foot { padding-top: 14px; border-top: 1px solid var(--line); font-size: 11px; }`;
  return page(
    theme,
    `<div class="hiw">
  <div class="card big">
    <div><div class="label">How it moves</div><h3>A small model picks every click</h3>
      <p>Drex Max reads the page's controls and picks one per move, for a fraction of a cent.
      It hands a move to the LLM only when it is unsure or stuck.</p></div>
    <div><div class="opts">${options}</div><div class="label vcap">One move · one choice · Drex Max</div></div>
  </div>
  <div class="three">
    ${card("Plans and reads", "An LLM plans, reads and checks", "Claude Haiku 5.5 by default, or a model from OpenAI, Google, OpenRouter or Fireworks. It turns the task into steps, reads the pages and checks the result.", plan, "Plan · read · check")}
    ${card("Asks first", "Risky clicks wait for you", "Pay, send, delete, publish and order clicks stop for approval. It never types passwords, and it hands sign-ins and CAPTCHAs back to you.", approval, "No passwords · no CAPTCHAs")}
    ${card("Runs where you work", "For coding agents and people", "An MCP server or a CLI for coding agents, and a Chrome side panel for people, all with the same agent. Cloud runs for apps come later.", `<div class="ways">${ways}</div>`, "Same agent · same result")}
  </div>
</div>`,
    css,
  );
}

const images = [
  ["header-light.png", header("light", "wide"), 1200],
  ["header-dark.png", header("dark", "wide"), 1200],
  ["header-narrow.png", header("light", "narrow"), 800],
  ["benchmarks-light.png", benchmarks("light"), 1200],
  ["benchmarks-dark.png", benchmarks("dark"), 1200],
  ["how-it-works-light.png", howItWorks("light"), 1200],
  ["how-it-works-dark.png", howItWorks("dark"), 1200],
];

const browser = await chromium.launch();
try {
  const tab = await browser.newPage({ deviceScaleFactor: 2 });
  for (const [name, html, width] of images) {
    await tab.setViewportSize({ width: width + 40, height: 400 });
    await tab.setContent(html);
    await tab.evaluate("document.fonts.ready");
    await tab
      .locator(".frame")
      .screenshot({ path: new URL(`docs/assets/${name}`, root).pathname, omitBackground: true });
    console.log(`docs/assets/${name}`);
  }
} finally {
  await browser.close();
}
