// The runner end to end with real keys, on the repo's test pages (e2e/site): `nace-browser run --json` reads a menu,
// and is stopped before paying an invoice. Skipped without DREX_API_KEY and ANTHROPIC_API_KEY, Playwright's Chromium
// or an extension build (npm run build:release, or NACE_BROWSER_EXTENSION). Each run costs at most $0.04.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

const ROOT = new URL("..", import.meta.url).pathname;
const BIN = path.join(ROOT, "runner/bin/nace-browser.mjs");
const SITE = path.join(ROOT, "e2e/site");
const EXTENSION = process.env.NACE_BROWSER_EXTENSION || path.join(ROOT, "runner/extension");

async function why() {
  if (!process.env.DREX_API_KEY || !process.env.ANTHROPIC_API_KEY) return "needs DREX_API_KEY and ANTHROPIC_API_KEY";
  if (!fs.existsSync(path.join(EXTENSION, "manifest.json"))) return "needs npm run build:release";
  const { chromium } = await import("playwright");
  if (!fs.existsSync(chromium.executablePath())) return "needs nace-browser install";
  return "";
}
const skip = (await why()) || false; // node:test reports an empty reason as a skip too

let server;
let base;
const posts = [];
before(async () => {
  if (skip) return;
  server = http.createServer((req, res) => {
    if (req.method === "POST") {
      posts.push(req.url); // invoice.html's Pay now button
      res.writeHead(204).end();
      return;
    }
    const file = path.join(SITE, decodeURIComponent(new URL(req.url, "http://x").pathname));
    if (!file.startsWith(SITE) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-type": file.endsWith(".html") ? "text/html" : "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise((r) => server.listen(Number(process.env.E2E_PORT) || 0, "127.0.0.1", r)); // E2E_PORT: a shared machine's own range
  base = `http://127.0.0.1:${server.address().port}`;
});
const homes = [];
after(() => {
  server?.close();
  for (const home of homes) fs.rmSync(home, { recursive: true, force: true });
});

/** `nace-browser run --json` as an agent calls it: the result is all of stdout. */
function run(task, url) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nb-e2e-"));
  homes.push(home); // removed after the tests, which read the artifacts in it
  const env = { ...process.env, NACE_BROWSER_HOME: home, NACE_BROWSER_EXTENSION: EXTENSION };
  const child = spawn(process.execPath, [BIN, "run", task, "--url", url, "--json", "--temp-profile"], { env });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  if (process.env.SHOW_RUN) child.stderr.pipe(process.stderr);
  return new Promise((resolve) => child.on("exit", (code) => resolve({ code, result: JSON.parse(out) })));
}

test(
  "a read-only task succeeds, with the API's result shape and its artifacts on disk",
  { skip, timeout: 300000 },
  async () => {
    const { code, result: r } = await run(
      "What dish is on this restaurant's menu, and what does it cost?",
      `${base}/store.html?s=jade`,
    );
    assert.equal(r.status, "succeeded", JSON.stringify(r.outcome));
    assert.equal(code, 0);
    assert.equal(r.outcome.kind, "completed");
    assert.match(r.answer_text, /Kung Pao Shrimp/i);
    assert.match(r.answer_text, /15\.90/);
    assert.ok(r.steps.length >= 1);
    assert.ok(r.usage.drex_input_tokens + r.usage.llm_input_tokens > 0);
    assert.ok(r.usage.cost_usd > 0 && r.usage.cost_usd <= 0.04 + 0.01);
    for (const a of r.artifacts) assert.ok(fs.existsSync(a.path), a.path);
    assert.deepEqual(r.artifacts.map((a) => a.kind).sort(), ["result", "run_log", "screenshot"]);
  },
);

test(
  "paying is denied: the run ends partial, risky_action_denied, and nothing is paid",
  { skip, timeout: 300000 },
  async () => {
    const { code, result: r } = await run("Pay this invoice with the card on file.", `${base}/invoice.html`);
    assert.equal(code, 1);
    assert.equal(r.status, "partial", JSON.stringify(r.outcome));
    assert.equal(r.outcome.kind, "risky_action_denied");
    assert.match(r.outcome.reason, /pay/i);
    assert.deepEqual(posts, [], "the Pay now button was never clicked");
  },
);
