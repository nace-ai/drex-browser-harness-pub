import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { HostedBudget, providerUsage } from "../runner/src/hosted-budget.mjs";
import { modelTransport } from "../runner/src/worker-transport.mjs";

function funding(budget = "1000000") {
  return {
    budget_nusd: budget,
    started_at_ms: Date.now(),
    expires_at_ms: Date.now() + 60000,
    prices: { drex_input: "1", llm_input: "1", llm_output: "1", browser_second: "1000" },
  };
}
const decision = { model: "drex-max", state: "test", questions: { decision: {} } };

test("concurrent physical calls share a hard ceiling even before any usage arrives", () => {
  const budget = new HostedBudget(funding());
  try {
    budget.reserve("drex", decision);
    budget.reserve("drex", decision);
    budget.reserve("drex", decision);
    assert.throws(() => budget.reserve("drex", decision), /budget exhausted/);
    assert.equal(budget.signal.aborted, true);
  } finally {
    budget.dispose();
  }
});

test("sandbox time aborts a running provider call when no funds remain", async () => {
  const spec = funding("2000");
  spec.started_at_ms = Date.now() - 1980;
  const budget = new HostedBudget(spec);
  try {
    await new Promise((resolve) =>
      budget.signal.aborted ? resolve() : budget.signal.addEventListener("abort", resolve, { once: true }),
    );
    assert.equal(budget.signal.aborted, true);
  } finally {
    budget.dispose();
  }
});

test("unknown provider outcome stops retries and retains the full liability", () => {
  const budget = new HostedBudget(funding());
  try {
    const ticket = budget.reserve("drex", decision);
    budget.settle(ticket, null);
    assert.equal(budget.held, 262144n);
    assert.equal(budget.exhausted, false);
    assert.throws(() => budget.reserve("drex", decision));
    assert.throws(() => budget.settle(ticket, { input: 1, output: 0 }), /Duplicate/);
  } finally {
    budget.dispose();
  }
});

test("funded transport refuses an unfunded call before the provider receives it", async () => {
  let calls = 0;
  const server = http.createServer((_req, res) => {
    calls++;
    res.end(JSON.stringify({ usage: { input_tokens: 100 } }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const budget = new HostedBudget(funding("5000"));
  try {
    const transport = modelTransport({ drexUrl: url, llmUrl: url, budget, signal: budget.signal });
    await assert.rejects(
      transport({ url: "https://console.nace.ai/v1/systemone", method: "POST", body: JSON.stringify(decision) }),
      /budget exhausted/,
    );
    assert.equal(calls, 0);
  } finally {
    budget.dispose();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("truncated provider SSE never releases the unknown liability", () => {
  const start = 'data: {"type":"message_start","message":{"usage":{"input_tokens":12,"output_tokens":0}}}\n';
  assert.equal(providerUsage("llm", start), null);
  assert.deepEqual(
    providerUsage(
      "llm",
      start + 'data: {"type":"message_delta","usage":{"output_tokens":4}}\ndata: {"type":"message_stop"}\n',
    ),
    { input: 12, output: 4 },
  );
});
