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
const llm = { llmModel: "claude-haiku-5-5" };
const decision = { model: "drex-max", state: "test", questions: { decision: {} } };

async function fundedServer(handler, run) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}
const drexCall = (transport) =>
  transport({ url: "https://console.nace.ai/v1/systemone", method: "POST", body: JSON.stringify(decision) });

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
  // the reservation, the 10-second cleanup reserve and 1.5 browser seconds: the timer stops the run a second in
  const spec = funding(String(262144 + 10000 + 1500));
  let received;
  const arrived = new Promise((resolve) => (received = resolve));
  await fundedServer(
    (_req, res) => {
      res.writeHead(200);
      res.write("{");
      received();
    },
    async (url) => {
      const budget = new HostedBudget(spec);
      try {
        const transport = modelTransport({ drexUrl: url, llmUrl: url, budget, signal: budget.signal });
        const call = drexCall(transport);
        await arrived;
        assert.equal(budget.signal.aborted, false);
        await call;
        assert.equal(budget.signal.aborted, true);
        assert.equal(budget.exhausted, true);
        assert.equal(budget.held, 262144n, "a cut-off call keeps its liability");
        assert.ok(Date.now() - spec.started_at_ms >= 1000);
      } finally {
        budget.dispose();
      }
    },
  );
});

test("a call reserved after the grant's end is refused and holds nothing", () => {
  let now = Date.now();
  const spec = { ...funding("100000000"), started_at_ms: now, expires_at_ms: now + 60000 };
  const budget = new HostedBudget(spec, { now: () => now });
  try {
    now += 50000; // the timer has not fired yet
    assert.throws(() => budget.reserve("drex", decision), /budget exhausted/);
    assert.equal(budget.held, 0n);
    assert.equal(budget.exhausted, true);
  } finally {
    budget.dispose();
  }
});

test("usage above its reservation stops the run as exhausted; unreadable usage keeps the liability", () => {
  const over = new HostedBudget(funding("100000000"));
  try {
    over.settle(over.reserve("drex", decision), { input: 262145, output: 0 });
    assert.equal(over.exhausted, true);
    assert.equal(over.spent, 262145n);
  } finally {
    over.dispose();
  }
  for (const usage of [
    { input: -1, output: 0 },
    { input: 1.5, output: 0 },
    { input: "9", output: 0 },
  ]) {
    const budget = new HostedBudget(funding("100000000"));
    try {
      budget.settle(budget.reserve("drex", decision), usage);
      assert.equal(budget.held, 262144n, JSON.stringify(usage));
      assert.equal(budget.spent, 0n);
      assert.equal(budget.exhausted, false);
      assert.equal(budget.signal.aborted, true);
    } finally {
      budget.dispose();
    }
  }
});

test("unknown provider outcome stops retries and retains the full liability", () => {
  const budget = new HostedBudget(funding());
  try {
    const ticket = budget.reserve("drex", decision);
    budget.settle(ticket, null);
    assert.equal(budget.held, 262144n);
    assert.equal(budget.exhausted, false);
    assert.throws(() => budget.reserve("drex", decision), /outcome is unknown/);
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

test("a complete HTTP error answer is released so the extension can retry it; a 2xx settles its usage", async () => {
  let status = 429;
  await fundedServer(
    (_req, res) => {
      res.writeHead(status);
      res.end(JSON.stringify(status === 200 ? { usage: { input_tokens: 100 } } : { error: "busy" }));
    },
    async (url) => {
      const budget = new HostedBudget(funding("100000000"));
      try {
        const transport = modelTransport({ drexUrl: url, llmUrl: url, budget, signal: budget.signal });
        assert.equal((await drexCall(transport)).status, 429);
        assert.equal(budget.held, 0n);
        assert.equal(budget.signal.aborted, false);
        status = 200;
        assert.equal((await drexCall(transport)).status, 200);
        assert.equal(budget.held, 0n);
        assert.equal(budget.spent, 100n);
        assert.equal(budget.usage.drex_input_tokens, 100);
      } finally {
        budget.dispose();
      }
    },
  );
});

test("a gateway 5xx or 408 keeps its reservation and stops the run", async () => {
  for (const status of [408, 500, 502, 503, 504]) {
    await fundedServer(
      (_req, res) => {
        res.writeHead(status);
        res.end("<html>gateway</html>");
      },
      async (url) => {
        const budget = new HostedBudget(funding("100000000"));
        try {
          const transport = modelTransport({ drexUrl: url, llmUrl: url, budget, signal: budget.signal });
          assert.equal((await drexCall(transport)).status, status);
          assert.equal(budget.held, 262144n);
          assert.equal(budget.signal.aborted, true);
          assert.equal(budget.exhausted, false, "an unknown outcome is not a budget stop");
        } finally {
          budget.dispose();
        }
      },
    );
  }
});

test("an aborted run neither reserves nor sends another provider call", async () => {
  let calls = 0;
  await fundedServer(
    (_req, res) => {
      calls++;
      res.end("{}");
    },
    async (url) => {
      const budget = new HostedBudget(funding("100000000"));
      const controller = new AbortController();
      controller.abort();
      try {
        const transport = modelTransport({ drexUrl: url, llmUrl: url, budget, signal: controller.signal });
        await assert.rejects(drexCall(transport));
        assert.equal(calls, 0);
        assert.equal(budget.held, 0n);
        assert.equal(budget.signal.aborted, false);
      } finally {
        budget.dispose();
      }
    },
  );
});

test("WebP screenshots are bounded from their header like PNG and JPEG; unreadable images are refused", () => {
  const riff = (chunk, payload) => {
    const body = Buffer.concat([Buffer.from(chunk, "latin1"), Buffer.alloc(4), payload]);
    body.writeUInt32LE(payload.length, 4);
    const head = Buffer.from("RIFF\0\0\0\0WEBP", "latin1");
    head.writeUInt32LE(body.length + 4, 4);
    return Buffer.concat([head, body]);
  };
  const vp8x = Buffer.alloc(10);
  vp8x.writeUIntLE(1280 - 1, 4, 3);
  vp8x.writeUIntLE(800 - 1, 7, 3);
  const vp8l = Buffer.alloc(10);
  vp8l[0] = 0x2f;
  vp8l.writeUInt32LE((1280 - 1) | ((800 - 1) << 14), 1);
  const vp8 = Buffer.alloc(10);
  vp8.set([0x9d, 0x01, 0x2a], 3);
  vp8.writeUInt16LE(1280, 6);
  vp8.writeUInt16LE(800, 8);
  const request = (media_type, data) => ({
    model: "claude-haiku-5-5",
    max_tokens: 100,
    messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type, data } }] }],
  });
  const tokens = Math.ceil(40 * 25 * 2.46 + 2240);
  for (const image of [riff("VP8X", vp8x), riff("VP8L", vp8l), riff("VP8 ", vp8)]) {
    const budget = new HostedBudget(funding("100000000"), llm);
    try {
      const body = request("image/webp", image.toString("base64"));
      const text = JSON.stringify(body, (key, value) => (key === "source" ? { type: "image" } : value));
      const ticket = budget.reserve("llm", body);
      assert.equal(ticket.bound, BigInt(Buffer.byteLength(text) + 4096 + tokens + 100));
    } finally {
      budget.dispose();
    }
  }
  const png = Buffer.alloc(24);
  png.set([137, 80, 78, 71, 13, 10, 26, 10]);
  png.writeUInt32BE(1280, 16);
  png.writeUInt32BE(800, 20);
  // SOI, an APP0 and a DHT (C4, not a frame) before the SOF0 that gives the size
  const jpeg = Buffer.from([
    0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc4, 0, 4, 0, 0, 0xff, 0xc0, 0, 17, 8, 0, 0, 0, 0, 3, 0, 0, 0, 0,
  ]);
  jpeg.writeUInt16BE(800, 19);
  jpeg.writeUInt16BE(1280, 21);
  for (const [media, image] of [
    ["image/png", png],
    ["image/jpeg", jpeg],
  ]) {
    const budget = new HostedBudget(funding("100000000"), llm);
    try {
      const body = request(media, image.toString("base64"));
      const text = JSON.stringify(body, (key, value) => (key === "source" ? { type: "image" } : value));
      assert.equal(budget.reserve("llm", body).bound, BigInt(Buffer.byteLength(text) + 4096 + tokens + 100), media);
    } finally {
      budget.dispose();
    }
  }
  const huge = Buffer.from(png);
  huge.writeUInt32BE(20001, 16);
  const budget = new HostedBudget(funding("100000000"), llm);
  try {
    assert.throws(() => budget.reserve("llm", request("image/gif", "R0lGODlh")), /Unbounded funded image/);
    assert.throws(() => budget.reserve("llm", request("image/png", huge.toString("base64"))), /Unbounded funded image/);
    assert.throws(
      () => budget.reserve("llm", request("image/png", png.subarray(0, 20).toString("base64"))),
      /Unbounded/,
    );
  } finally {
    budget.dispose();
  }
});

test("usage is read across stream events and complete JSON replies, keeping cache tokens", () => {
  const stream =
    'data: {"type":"message_start","message":{"usage":{"input_tokens":10,"cache_read_input_tokens":5,"output_tokens":1}}}\n' +
    'data: {"type":"message_delta","usage":{"input_tokens":10,"output_tokens":7}}\n' +
    'data: {"type":"message_stop"}\n';
  assert.deepEqual(providerUsage("llm", stream), { input: 15, output: 7 });
  const reply = {
    stop_reason: "end_turn",
    usage: { input_tokens: 3, cache_creation_input_tokens: 2, output_tokens: 4 },
  };
  assert.deepEqual(providerUsage("llm", JSON.stringify(reply)), { input: 5, output: 4 });
  assert.equal(providerUsage("llm", JSON.stringify({ ...reply, stop_reason: null })), null);
  assert.deepEqual(providerUsage("drex", JSON.stringify({ usage: { input_tokens: 9 } })), { input: 9, output: 0 });
  assert.equal(providerUsage("drex", "{"), null);
});

test("funds and grant time for cleanup and the report are kept back from the run", () => {
  // 15 browser seconds funded, 10 kept for cleanup: a call that leaves fewer than 10 is refused
  const budget = new HostedBudget(funding("15000"), llm);
  try {
    assert.equal(budget.signal.aborted, false);
    assert.throws(
      () => budget.reserve("llm", { model: llm.llmModel, max_tokens: 1000, messages: [] }),
      /budget exhausted/,
    );
  } finally {
    budget.dispose();
  }
  const spec = funding("100000000");
  spec.expires_at_ms = Date.now() + 9000;
  const expiring = new HostedBudget(spec);
  try {
    assert.equal(expiring.signal.aborted, true, "a grant ending before the cleanup reserve is already exhausted");
    assert.equal(expiring.exhausted, true);
  } finally {
    expiring.dispose();
  }
});

test("the report's window is the funded lifetime left after the run, cleanup reserve included", () => {
  const spec = funding("40000");
  const budget = new HostedBudget(spec, llm);
  try {
    // 40 browser seconds funded: the run stops 10 before them, the report may use those 10
    assert.equal(budget.until(), spec.started_at_ms + 30000);
    assert.equal(budget.until(0n), spec.started_at_ms + 40000);
    // held funds shorten both
    budget.reserve("llm", { model: llm.llmModel, max_tokens: 1000, messages: [] });
    assert.ok(budget.until(0n) < spec.started_at_ms + 40000);
  } finally {
    budget.dispose();
  }
});

test("a funded LLM call is refused for another model or for work its body does not bound", () => {
  const budget = new HostedBudget(funding("100000000"), llm);
  const call = (extra) => ({
    model: llm.llmModel,
    max_tokens: 100,
    messages: [{ role: "user", content: "hi" }],
    ...extra,
  });
  try {
    budget.reserve("llm", call({ tools: [{ name: "click", input_schema: { type: "object" } }] }));
    for (const body of [
      call({ model: "claude-opus-5-5" }),
      call({ tools: [{ type: "web_fetch_20250910", name: "web_fetch" }] }),
      call({ mcp_servers: [] }),
      call({ container: "c" }),
      call({
        messages: [
          { role: "user", content: [{ type: "image", source: { type: "url", url: "https://example.com/a.png" } }] },
        ],
      }),
    ])
      assert.throws(() => budget.reserve("llm", body), /Unsupported funded LLM request|Unbounded funded image/);
  } finally {
    budget.dispose();
  }
  const unpinned = new HostedBudget(funding("100000000"));
  try {
    assert.throws(() => unpinned.reserve("llm", call()), /Unsupported funded LLM request/);
  } finally {
    unpinned.dispose();
  }
});
