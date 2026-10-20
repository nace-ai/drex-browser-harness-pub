// The runner's MCP server (runner/src/mcp.mjs): its three tools, that an agent can't allow risky actions or raise the
// limits, and that `nace-browser mcp` speaks clean MCP on stdio (nothing else on stdout).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { PassThrough } from "node:stream";
import { createServer, serve } from "../runner/src/mcp.mjs";

const BIN = new URL("../runner/bin/nace-browser.mjs", import.meta.url).pathname;

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nb-mcp-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function connect(deps) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createServer(deps).connect(a);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(b);
  return client;
}

test("browser_task runs with risky actions denied and the limits an agent asked for, never higher", async () => {
  const calls = [];
  const run = async (opts, { onProgress }) => {
    calls.push(opts);
    onProgress("step 1 running");
    return { status: "succeeded", answer_text: "42", outcome: { kind: "completed", reason: null, evidence: [] } };
  };
  const client = await connect({ env: {}, run });
  const r = await client.callTool({
    name: "browser_task",
    arguments: { task: "count the rows", start_url: "https://a.example/", max_cost_usd: 0.01, max_seconds: 60 },
  });
  assert.equal(r.isError, undefined);
  assert.equal(r.structuredContent.answer_text, "42");
  assert.deepEqual(calls, [
    {
      task: "count the rows",
      url: "https://a.example/",
      profile: "default",
      headed: false,
      limits: { maxCostUsd: 0.01, maxSeconds: 60, maxLlmCalls: 20 },
      allowRisky: false,
    },
  ]);
  const over = await client.callTool({
    name: "browser_task",
    arguments: { task: "x", start_url: "https://a.example/", max_cost_usd: 0.5 },
  });
  assert.equal(over.isError, true);
  assert.equal(calls.length, 1, "a run over the cap never starts");
  // arguments the schema doesn't have can't allow risky clicks or raise the LLM calls
  await client.callTool({
    name: "browser_task",
    arguments: { task: "x", start_url: "https://a.example/", allow_risky: true, allowRisky: true, max_llm_calls: 1000 },
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].allowRisky, false);
  assert.deepEqual(calls[1].limits, { maxSeconds: 600, maxLlmCalls: 20 });
  const bad = await client.callTool({ name: "browser_task", arguments: { task: "x", start_url: "file:///etc/hosts" } });
  assert.equal(bad.isError, true);
  assert.match(bad.structuredContent.error.message, /http or https/);
  await client.close();
});

test("a bad profile name is the agent's own error (invalid_request), and no browser starts", async () => {
  const started = [];
  const client = await connect({
    env: {},
    run: async () => started.push("run"),
    signIn: async () => started.push("login"),
  });
  for (const [name, args] of [
    ["browser_task", { task: "x", start_url: "https://a.example/", profile: "../x" }],
    ["browser_login", { url: "https://a.example/", profile: "../x" }],
  ]) {
    const r = await client.callTool({ name, arguments: args });
    assert.equal(r.isError, true, name);
    assert.equal(r.structuredContent.error.code, "invalid_request", name);
  }
  assert.deepEqual(started, []);
  await client.close();
});

test("an unexpected error is runner_error, not the system error's own code", async () => {
  const run = async () => {
    throw Object.assign(new Error("EACCES: permission denied, mkdir '/x'"), { code: "EACCES" });
  };
  const client = await connect({ env: {}, run });
  const r = await client.callTool({ name: "browser_task", arguments: { task: "x", start_url: "https://a.example/" } });
  assert.equal(r.isError, true);
  assert.equal(r.structuredContent.error.code, "runner_error");
  assert.match(r.structuredContent.error.message, /EACCES/);
  await client.close();
});

test("the tools: no allow_risky anywhere, and browser_profiles lists the profiles", async (t) => {
  const home = tmp(t);
  fs.mkdirSync(path.join(home, "profiles", "mail"), { recursive: true });
  const client = await connect({ env: { NACE_BROWSER_HOME: home } });
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ["browser_login", "browser_profiles", "browser_task"]);
  for (const t of tools) assert.ok(!JSON.stringify(t.inputSchema).includes("risky"), t.name);
  const task = tools.find((t) => t.name === "browser_task");
  assert.equal(task.annotations.readOnlyHint, false);
  assert.equal(task.annotations.destructiveHint, true, "the click guard cannot prevent all destructive actions");
  assert.deepEqual(task.inputSchema.required.sort(), ["start_url", "task"]);
  const r = await client.callTool({ name: "browser_profiles", arguments: {} });
  assert.deepEqual(
    r.structuredContent.profiles.map((p) => p.name),
    ["mail"],
  );
  await client.close();
});

test("nace-browser mcp over stdio: a run without keys answers a tool error, not a crash", async (t) => {
  const home = tmp(t);
  const env = { PATH: process.env.PATH, HOME: home, NACE_BROWSER_HOME: home };
  const client = new Client({ name: "test", version: "0" });
  await client.connect(
    new StdioClientTransport({ command: process.execPath, args: [BIN, "mcp"], env, stderr: "ignore" }),
  );
  assert.equal(client.getServerVersion().name, "nace-browser");
  const r = await client.callTool({ name: "browser_task", arguments: { task: "x", start_url: "https://a.example/" } });
  assert.equal(r.isError, true);
  assert.equal(r.structuredContent.error.code, "missing_keys");
  await client.close();
});

test("a client hanging up (stdin ends) cancels a running browser_task", { timeout: 10000 }, async () => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  let started;
  const running = new Promise((r) => (started = r));
  const cancelled = new Promise((resolve) => {
    const run = (_opts, { signal }) => {
      started();
      signal.addEventListener("abort", () => resolve("aborted"), { once: true });
      return new Promise(() => {});
    };
    void serve({ stdin, stdout, env: {}, run });
  });
  const send = (m) => stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...m })}\n`);
  send({
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } },
  });
  send({ method: "notifications/initialized" });
  send({
    id: 2,
    method: "tools/call",
    params: { name: "browser_task", arguments: { task: "x", start_url: "https://a.example/" } },
  });
  await running;
  stdin.end();
  assert.equal(await cancelled, "aborted");
});

test(
  "SIGTERM ends nace-browser mcp itself (Playwright's handlers would only close the browsers)",
  { timeout: 10000 },
  async (t) => {
    const home = tmp(t);
    const child = spawn(process.execPath, [BIN, "mcp"], { env: { PATH: process.env.PATH, NACE_BROWSER_HOME: home } });
    t.after(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    });
    const exited = new Promise((r) => child.on("exit", (code, signal) => r({ code, signal })));
    // serving, with its signal handlers on, once it answers initialize
    const answered = new Promise((r) => child.stdout.once("data", r));
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } },
      })}\n`,
    );
    await answered;
    child.kill("SIGTERM");
    assert.deepEqual(await exited, { code: 143, signal: null });
  },
);
