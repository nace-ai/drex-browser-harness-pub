import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { existsSync } from "node:fs";
import { launch, extensionDir, runTask } from "../runner/src/run.mjs";
import { connectTransport, modelTransport, restrictPages } from "../runner/src/worker-transport.mjs";
import { browserProxy } from "../runner/src/worker-network.mjs";
import { HostedBudget } from "../runner/src/hosted-budget.mjs";
import { runWorker } from "../runner/src/worker.mjs";

async function why() {
  try {
    extensionDir();
  } catch {
    return "needs npm run build:release";
  }
  const { chromium } = await import("playwright");
  if (!existsSync(chromium.executablePath())) return "needs nace-browser install";
  return "";
}
const reason = await why();
// CI builds the release and installs Chromium: a skip there would hide a broken isolation test
if (reason && process.env.NACE_REQUIRE_BROWSER_TESTS === "1") throw new Error(`Worker isolation test ${reason}.`);
const skip = reason || false; // node:test reports an empty reason as a skip too

test(
  "worker model channel works while pages and redirects cannot reach the model host",
  { skip, timeout: 120000 },
  async () => {
    const calls = [];
    let oversized = false;
    let noContent = false;
    let stall = false;
    let closed;
    const disconnected = new Promise((resolve) => (closed = resolve));
    const model = http.createServer((req, res) => {
      calls.push({ url: req.url, key: req.headers["x-api-key"] });
      if (noContent) return res.writeHead(204).end();
      if (stall) {
        res.on("close", closed);
        res.writeHead(200);
        res.write("{");
        return;
      }
      res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" });
      res.end(oversized ? Buffer.alloc(8 * 1024 * 1024 + 1, 0x20) : '{"content":[{"type":"text","text":"ok"}]}');
    });
    await new Promise((resolve) => model.listen(0, "127.0.0.1", resolve));
    const modelUrl = `http://127.0.0.1:${model.address().port}`;
    const site = http.createServer((req, res) => {
      if (req.url === "/redirect") {
        res.writeHead(302, { location: modelUrl });
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<title>Untrusted fixture</title><p>Public page</p>");
    });
    await new Promise((resolve) => site.listen(0, "127.0.0.1", resolve));
    const siteUrl = `http://127.0.0.1:${site.address().port}`;
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "worker-isolation-"));
    let ctx;
    const proxy = await browserProxy([siteUrl], { allowLocal: true });
    try {
      ctx = await launch(dir, { headless: true, extension: extensionDir(), proxy: proxy.url });
      await restrictPages(ctx, [siteUrl]);
      const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent("serviceworker"));
      const panel = await ctx.newPage();
      await panel.goto(`chrome-extension://${new URL(sw.url()).host}/sidepanel.html`);
      await connectTransport(
        panel,
        sw,
        modelTransport({
          drexUrl: modelUrl,
          llmUrl: modelUrl,
          llmKey: "fixture-secret",
        }),
      );
      const reply = await sw.evaluate(async () => {
        const r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", body: "{}" });
        return r.json();
      });
      assert.equal(reply.content[0].text, "ok");
      assert.deepEqual(calls, [{ url: "/v1/messages", key: "fixture-secret" }]);
      const page = await ctx.newPage();
      await page.goto(siteUrl);
      assert.equal(await page.evaluate(() => typeof globalThis.__naceWorkerFetch), "undefined");
      assert.equal(
        await page.evaluate(async (url) => {
          try {
            await fetch(url + "/v1/messages", { method: "POST", body: "{}" });
            return "leaked";
          } catch {
            return "blocked";
          }
        }, modelUrl),
        "blocked",
      );
      const redirected = await page.goto(siteUrl + "/redirect").catch(() => null);
      assert.ok(!redirected || redirected.status() === 403);
      assert.equal(calls.length, 1, "untrusted page made no model requests");
      await assert.rejects(
        sw.evaluate(async () => {
          await fetch("https://api.anthropic.com/arbitrary", { method: "POST", body: "{}" });
        }),
      );
      assert.equal(calls.length, 1, "trusted bridge is not an arbitrary HTTP proxy");
      noContent = true;
      // a bodyless status must settle the fetch, not throw inside the port listener
      assert.equal(
        await sw.evaluate(async () => {
          const r = await fetch("https://console.nace.ai/v1/systemone", { method: "POST", body: "{}" });
          return r.status;
        }),
        204,
      );
      noContent = false;
      oversized = true;
      for (const url of ["https://console.nace.ai/v1/systemone", "https://api.anthropic.com/v1/messages"]) {
        const broken = await sw.evaluate(async (url) => {
          let status = null;
          try {
            const response = await fetch(url, { method: "POST", body: "{}" });
            status = response.status;
            await response.json();
            return { status, error: null };
          } catch (error) {
            return { status, error: error.name };
          }
        }, url);
        // Drex must see an answered 2xx with an unreadable body; LLM must see a non-retryable plain Error.
        assert.deepEqual(
          broken,
          url.includes("systemone") ? { status: 200, error: "TypeError" } : { status: null, error: "Error" },
        );
      }
      oversized = false;
      stall = true;
      const cancelled = await sw.evaluate(async () => {
        const controller = new AbortController();
        setTimeout(() => controller.abort(), 300);
        try {
          await fetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            body: "{}",
            signal: controller.signal,
          });
          return "not cancelled";
        } catch (error) {
          return error.name;
        }
      });
      assert.equal(cancelled, "AbortError");
      await Promise.race([
        disconnected,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Provider kept running after port cancellation")), 2000),
        ),
      ]);
    } finally {
      await ctx?.close();
      await proxy.close();
      await fs.rm(dir, { recursive: true, force: true });
      await Promise.all([new Promise((r) => model.close(r)), new Promise((r) => site.close(r))]);
    }
  },
);

test(
  "an abort that reaches Node before its fetch is never reserved or sent; a closed panel aborts a call in flight",
  { timeout: 10000 },
  async () => {
    let received = 0;
    let arrived;
    const model = http.createServer((req) => {
      received++;
      req.resume();
      arrived(); // never answered: only an abort ends this call
    });
    await new Promise((resolve) => model.listen(0, "127.0.0.1", resolve));
    const bindings = {};
    const closes = [];
    const frame = {};
    const panel = {
      exposeBinding: async (name, fn) => void (bindings[name] = fn),
      once: (event, fn) => event === "close" && closes.push(fn),
      mainFrame: () => frame,
      url: () => "chrome-extension://ext/panel.html",
      evaluate: async () => {},
    };
    const source = { page: panel, frame };
    const budget = new HostedBudget({
      budget_nusd: "1000000000000",
      started_at_ms: Date.now(),
      expires_at_ms: Date.now() + 60000,
      prices: { drex_input: "1", llm_input: "1", llm_output: "1", browser_second: "0" },
    });
    const drexUrl = `http://127.0.0.1:${model.address().port}`;
    await connectTransport(panel, { evaluate: async () => {} }, modelTransport({ drexUrl, llmUrl: drexUrl, budget }));
    const request = {
      url: "https://console.nace.ai/v1/systemone",
      method: "POST",
      body: JSON.stringify({ model: "drex-max", questions: { q: "What is the title?" } }),
    };
    try {
      // the extension aborted before Node got its request: the call is neither reserved nor sent
      await bindings.__naceWorkerAbort(source, "early");
      await assert.rejects(bindings.__naceWorkerFetch(source, request, "early"), { name: "AbortError" });
      assert.equal(received, 0);
      assert.equal(budget.held, 0n);
      assert.equal(budget.signal.aborted, false);
      // a panel that closes mid-call aborts it: sent, so its outcome is unknown and the funded run stops
      const sent = new Promise((resolve) => (arrived = resolve));
      const call = bindings.__naceWorkerFetch(source, request, "late");
      await sent;
      for (const close of closes) close();
      await assert.rejects(call, { name: "AbortError" });
      assert.equal(received, 1);
      assert.equal(budget.signal.aborted, true);
      assert.equal(budget.exhausted, false);
      assert.ok(budget.held > 0n, "the cut-off call's liability was released");
    } finally {
      budget.dispose();
      model.closeAllConnections();
      await new Promise((resolve) => model.close(resolve));
    }
  },
);

test("only a model call that got no answer is reported as unanswered; a billed failure stays an error", async () => {
  const model = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(Buffer.alloc(8 * 1024 * 1024 + 1, 0x20)); // past the worker's response cap
  });
  await new Promise((resolve) => model.listen(0, "127.0.0.1", resolve));
  const request = { url: "https://api.anthropic.com/v1/messages", method: "POST", body: "{}" };
  try {
    const answered = modelTransport({
      drexUrl: "http://127.0.0.1:9",
      llmUrl: `http://127.0.0.1:${model.address().port}`,
    });
    const oversized = await answered(request);
    assert.equal(oversized.status, 200);
    assert.equal(oversized.bodyError, true);
    await assert.rejects(answered({ ...request, url: "https://api.anthropic.com/v1/other" }), /refused/);
    const closed = net.createServer();
    await new Promise((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const port = closed.address().port;
    await new Promise((resolve) => closed.close(resolve));
    const unanswered = modelTransport({ drexUrl: "http://127.0.0.1:9", llmUrl: `http://127.0.0.1:${port}` });
    assert.deepEqual(await unanswered(request), { unanswered: true });
    const stopped = new AbortController();
    stopped.abort();
    await assert.rejects(
      modelTransport({ drexUrl: "http://127.0.0.1:9", llmUrl: `http://127.0.0.1:${port}`, signal: stopped.signal })(
        request,
      ),
      { name: "AbortError" },
    );
  } finally {
    await new Promise((resolve) => model.close(resolve));
  }
});

test(
  "a funding stop closes Chromium during a model call without the cooperative stop wait",
  { skip, timeout: 15000 },
  async () => {
    const site = http.createServer((_req, res) => res.end("<title>Funding fixture</title><p>Find the title</p>"));
    await new Promise((resolve) => site.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${site.address().port}`;
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "funded-stop-"));
    const stop = new AbortController();
    let called = 0;
    let cleanups = 0;
    let stoppedAt;
    try {
      await runTask(
        {
          task: "Read the title",
          url,
          tempProfile: true,
          out: dir,
          allowedOrigins: [url],
          limits: { maxSeconds: 600, maxLlmCalls: 20 },
        },
        {
          env: { DREX_API_KEY: "fixture", ANTHROPIC_API_KEY: "fixture" },
          // only the kill: no cooperative stop is ever asked for, so the run can end only by Chromium closing
          killSignal: stop.signal,
          onCleanup: () => cleanups++,
          allowLocal: true,
          handleSignals: false,
          transport: async () => {
            called++;
            setTimeout(() => {
              stoppedAt = performance.now();
              stop.abort();
            }, 100);
            return new Promise(() => {}); // provider never answers; browser shutdown must not wait for it
          },
        },
      ).catch(() => {});
      assert.equal(called, 1);
      assert.equal(cleanups, 1);
      assert.ok(performance.now() - stoppedAt < 5000, "funding stop waited for cooperative teardown");
    } finally {
      stop.abort();
      site.closeAllConnections();
      await new Promise((resolve) => site.close(resolve));
      await fs.rm(dir, { recursive: true, force: true });
    }
  },
);

test(
  "a funded startup deadline aborts Chromium launch before any page or model work",
  { skip, timeout: 15000 },
  async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "funded-launch-"));
    let cleanups = 0;
    const began = performance.now();
    try {
      await assert.rejects(
        runTask(
          {
            task: "Never execute",
            url: "http://127.0.0.1:1/",
            tempProfile: true,
            out: dir,
            launchDeadline: performance.now() - 1,
            limits: { maxSeconds: 1 },
          },
          {
            env: { DREX_API_KEY: "fixture", ANTHROPIC_API_KEY: "fixture" },
            handleSignals: false,
            onCleanup: () => cleanups++,
          },
        ),
        { code: "browser_failed" },
      );
      assert.equal(cleanups, 1);
      assert.ok(performance.now() - began < 10000, "launch outlived its deadline");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  },
);

test(
  "a run whose provider call gets a gateway error reports internal_error with the call's liability in its bound",
  { skip, timeout: 60000 },
  async () => {
    const site = http.createServer((_req, res) => res.end("<title>Funding fixture</title><p>Find the title</p>"));
    let calls = 0;
    // a gateway 502 may follow billed provider work: its outcome is unknown
    const model = http.createServer((req, res) => {
      calls++;
      req.resume();
      res.writeHead(502).end("{}");
    });
    const received = [];
    const callback = http.createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      received.push(JSON.parse(body));
      res.end("{}");
    });
    for (const server of [site, model, callback])
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    // a page origin may not share the Drex or LLM host
    const url = `http://localhost:${site.address().port}`;
    const modelBase = `http://127.0.0.1:${model.address().port}`;
    const base = `http://127.0.0.1:${callback.address().port}`;
    try {
      const event = await runWorker({
        DREX_PROTOCOL_VERSION: "2",
        DREX_RUN_ID: "brun_" + "a".repeat(32),
        DREX_CALLBACK_SECRET: "whsec_" + Buffer.alloc(32, 1).toString("base64"),
        DREX_CALLBACK_URL: `${base}/api/webhooks/browser-runs`,
        DREX_BASE_URL: base,
        LLM_BASE_URL: modelBase,
        DREX_WORKER_ALLOW_LOCAL: "1",
        DREX_RUN_SPEC: JSON.stringify({
          task: "Read the title.",
          start_url: `${url}/`,
          allowed_origins: [url],
          answer_schema: null,
          risky_actions: "deny",
          limits: { max_cost_usd: 1, max_seconds: 60, max_llm_calls: 5 },
          artifacts: { screenshots: false, har: false },
          funding: {
            budget_nusd: "1000000000000",
            started_at_ms: Date.now(),
            expires_at_ms: Date.now() + 60000,
            // free sandbox seconds: the bound is then exactly the retained reservation
            prices: { drex_input: "1", llm_input: "1", llm_output: "1", browser_second: "0" },
          },
        }),
      });
      assert.ok(calls >= 1);
      assert.equal(received.length, 1);
      assert.deepEqual(received[0].data, event.data);
      assert.equal(event.data.outcome.kind, "internal_error");
      assert.equal(event.data.budget_exhausted, false);
      assert.ok(BigInt(event.data.resource_bound_nusd) > 0n, "the unknown call's reservation was dropped");
      assert.deepEqual(event.data.usage, { drex_input_tokens: 0, llm_input_tokens: 0, llm_output_tokens: 0 });
    } finally {
      for (const server of [site, model, callback]) {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      }
    }
  },
);
