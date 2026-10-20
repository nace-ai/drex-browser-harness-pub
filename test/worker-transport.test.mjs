import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { existsSync } from "node:fs";
import { launch, extensionDir } from "../runner/src/run.mjs";
import { connectTransport, modelTransport, restrictPages } from "../runner/src/worker-transport.mjs";
import { browserProxy } from "../runner/src/worker-network.mjs";

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
    const model = http.createServer((req, res) => {
      calls.push({ url: req.url, key: req.headers["x-api-key"] });
      if (noContent) return res.writeHead(204).end();
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
    } finally {
      await ctx?.close();
      await proxy.close();
      await fs.rm(dir, { recursive: true, force: true });
      await Promise.all([new Promise((r) => model.close(r)), new Promise((r) => site.close(r))]);
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
