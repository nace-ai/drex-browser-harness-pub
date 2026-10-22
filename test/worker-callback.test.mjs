import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHmac, randomBytes } from "node:crypto";
import { deliver, finishedEvent, runWorker, workerConfig } from "../runner/src/worker.mjs";

const env = () => ({
  DREX_PROTOCOL_VERSION: "2",
  DREX_RUN_ID: "brun_" + "a".repeat(32),
  DREX_CALLBACK_SECRET: "whsec_" + randomBytes(32).toString("base64"),
  DREX_CALLBACK_URL: "https://drex.example.com/api/webhooks/browser-runs",
  DREX_BASE_URL: "https://drex.example.com",
  LLM_BASE_URL: "https://api.anthropic.com",
  DREX_RUN_SPEC: JSON.stringify({
    task: "Read the title.",
    start_url: "https://example.com/",
    allowed_origins: ["https://example.com"],
    answer_schema: null,
    risky_actions: "deny",
    limits: { max_cost_usd: 0.04, max_seconds: 60, max_llm_calls: 5 },
    artifacts: { screenshots: true, har: false },
    funding: {
      budget_nusd: "40000000",
      started_at_ms: Date.now(),
      expires_at_ms: Date.now() + 60000,
      prices: { drex_input: "60", llm_input: "1000", llm_output: "5000", browser_second: "1000" },
    },
  }),
});
test("worker refuses incompatible protocol and credentialed browser origins before executing", () => {
  assert.equal(workerConfig(env()).spec.task, "Read the title.");
  assert.throws(() => workerConfig({ ...env(), DREX_PROTOCOL_VERSION: "3" }), /protocol/);
  // a v1 (unfunded) configuration is refused before any provider work
  assert.throws(() => workerConfig({ ...env(), DREX_PROTOCOL_VERSION: "1" }), /protocol/);
  const input = env(),
    spec = JSON.parse(input.DREX_RUN_SPEC);
  const { funding } = spec;
  delete spec.funding;
  assert.throws(() => workerConfig({ ...input, DREX_RUN_SPEC: JSON.stringify(spec) }), /specification/);
  spec.funding = funding;
  spec.start_url = "http://api.anthropic.com";
  spec.allowed_origins = [spec.start_url];
  assert.throws(() => workerConfig({ ...input, DREX_RUN_SPEC: JSON.stringify(spec) }), /origin/);
  assert.throws(
    () => workerConfig({ ...env(), DREX_CALLBACK_URL: "https://other.example.com/api/webhooks/browser-runs" }),
    /Callback/,
  );
  spec.allowed_origins = ["https://example.com"];
  spec.start_url = "https://example.com";
  spec.limits.max_llm_calls = 0;
  assert.throws(() => workerConfig({ ...input, DREX_RUN_SPEC: JSON.stringify(spec) }), /specification/);
});

test("start pages outside the declared origins, internal names and explicit ports are refused", () => {
  const refused = (change, pattern) => {
    const input = env(),
      spec = JSON.parse(input.DREX_RUN_SPEC);
    change(spec);
    assert.throws(() => workerConfig({ ...input, DREX_RUN_SPEC: JSON.stringify(spec) }), pattern);
  };
  refused((s) => (s.start_url = "https://other.example.com/"), /Start URL/);
  refused((s) => (s.start_url = "https://user:pass@example.com/"), /Start URL/);
  for (const origin of ["https://intranet", "https://printer.local", "https://example.com:8443"])
    refused((s) => ((s.allowed_origins = [origin]), (s.start_url = `${origin}/`)), /origin/);
});

test("credential-injected hosts are refused with a trailing dot, and base URLs must be bare origins", () => {
  for (const origin of ["https://api.anthropic.com.", "https://Console.Nace.AI.", "https://drex.example.com."]) {
    const spec = JSON.parse(env().DREX_RUN_SPEC);
    spec.allowed_origins = [origin];
    spec.start_url = `${origin}/`;
    assert.throws(() => workerConfig({ ...env(), DREX_RUN_SPEC: JSON.stringify(spec) }), /origin/, origin);
  }
  // the transport calls <origin>/v1/messages: a gateway path would be dropped without a word
  assert.throws(() => workerConfig({ ...env(), LLM_BASE_URL: "https://gw.example.com/anthropic" }), /endpoint/);
});

test("the runner's own time limit is reported as limit_reached, an unknown outcome as internal_error", () => {
  const kind = (k) => finishedEvent(env().DREX_RUN_ID, { outcome: { kind: k } }).data.outcome.kind;
  assert.equal(kind("timed_out"), "limit_reached");
  assert.equal(kind("cancelled"), "internal_error");
  assert.equal(kind("completed"), "completed");
});

test("a refused spec is reported to Drex as internal_error instead of leaving the run to its deadline", async () => {
  const received = [];
  const server = http.createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    received.push(JSON.parse(body));
    response.writeHead(status);
    response.end("{}");
  });
  let status = 200;
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const local = { ...env(), DREX_WORKER_ALLOW_LOCAL: "1", DREX_BASE_URL: base };
    const spec = JSON.parse(local.DREX_RUN_SPEC);
    spec.unknown_field = true;
    await assert.rejects(
      runWorker({
        ...local,
        DREX_CALLBACK_URL: `${base}/api/webhooks/browser-runs`,
        DREX_RUN_SPEC: JSON.stringify(spec),
      }),
      /specification/,
    );
    assert.equal(received.length, 1);
    assert.equal(received[0].data.outcome.kind, "internal_error");
    assert.equal(received[0].data.run_id, local.DREX_RUN_ID);
    // a report Drex refuses leaves the refusal as the error, with the delivery failure attached
    status = 400;
    await assert.rejects(
      runWorker({ ...local, DREX_CALLBACK_URL: `${base}/api/webhooks/browser-runs`, DREX_PROTOCOL_VERSION: "3" }),
      (e) => /protocol version/.test(e.message) && !!e.delivery,
    );
    assert.equal(received.length, 2);
    // without a valid run id and key nothing can be reported
    await assert.rejects(runWorker({ ...local, DREX_RUN_ID: "nope" }), /run id/);
    assert.equal(received.length, 2);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("an exhausted grant stops before the browser and reports a free budget stop with its resource bound", async () => {
  const received = [];
  const server = http.createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    received.push(JSON.parse(body));
    response.end("{}");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const input = { ...env(), DREX_WORKER_ALLOW_LOCAL: "1", DREX_BASE_URL: base };
    const spec = JSON.parse(input.DREX_RUN_SPEC);
    spec.funding.started_at_ms = Date.now() - 2000;
    spec.funding.expires_at_ms = Date.now() - 1;
    const event = await runWorker({
      ...input,
      DREX_CALLBACK_URL: `${base}/api/webhooks/browser-runs`,
      DREX_RUN_SPEC: JSON.stringify(spec),
    });
    assert.equal(received.length, 1);
    const data = received[0].data;
    assert.deepEqual(data, event.data);
    assert.equal(data.outcome.kind, "limit_reached");
    assert.equal(data.budget_exhausted, true);
    assert.equal(typeof data.resource_bound_nusd, "string");
    assert.ok(BigInt(data.resource_bound_nusd) >= 2000n);
    assert.deepEqual(data.usage, { drex_input_tokens: 0, llm_input_tokens: 0, llm_output_tokens: 0 });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("callback retries a transient failure with one signed event; permanent rejection is not retried", async () => {
  const key = randomBytes(32),
    received = [];
  let status = 503;
  const server = http.createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    received.push({ body, headers: request.headers });
    response.writeHead(status);
    response.end("{}");
    if (status === 503) status = 200;
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const config = { callback: `http://127.0.0.1:${server.address().port}`, callbackKey: key };
    const event = finishedEvent(env().DREX_RUN_ID, {
      outcome: { kind: "completed", evidence: [] },
      answer_text: "Title",
      usage: { drex_input_tokens: 123, llm_input_tokens: 456, llm_output_tokens: 7 },
      artifacts: [{ path: "/private/local-file.png" }],
    });
    await deliver(config, event, { timeoutMs: 3000 });
    assert.equal(received.length, 2);
    assert.equal(received[0].body, received[1].body);
    assert.equal(received[0].headers["webhook-id"], received[1].headers["webhook-id"]);
    for (const { body, headers } of received) {
      const signature = createHmac("sha256", key)
        .update(`${headers["webhook-id"]}.${headers["webhook-timestamp"]}.${body}`)
        .digest("base64");
      assert.equal(headers["webhook-signature"], `v1,${signature}`);
      assert.deepEqual(JSON.parse(body).data.artifacts, []);
      assert.equal(JSON.parse(body).data.usage.drex_input_tokens, 123);
    }
    status = 400;
    await assert.rejects(deliver(config, event, { timeoutMs: 3000 }), /400/);
    assert.equal(received.length, 3);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
