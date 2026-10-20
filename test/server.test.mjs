// The MCP server end to end, with fake extensions on the WebSocket side and a real MCP client on stdio: only a
// connection that proves the pairing code gets requests, and the server proves the code back.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { WebSocket } from "ws";
import { checkProof, newCode, proof, randomToken } from "../src/pairing.ts";

const SERVER = new URL("../mcp/server.mjs", import.meta.url).pathname;
const ORIGIN = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";

/** The server as a coding agent starts it, on its own port. */
async function startServer(code, port) {
  const env = { ...process.env, DREX_BRIDGE_PORT: String(port), DREX_PAIRING_CODE: code };
  const client = new Client({ name: "test", version: "0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [SERVER],
      env,
      stderr: process.env.SHOW_SERVER ? "inherit" : "ignore",
    }),
  );
  for (let i = 0; i < 40; i++) {
    // wait until it listens
    const ok = await new Promise((resolve) => {
      const s = new WebSocket(`ws://127.0.0.1:${port}`, { origin: ORIGIN });
      s.on("open", () => (s.close(), resolve(true)));
      s.on("error", () => resolve(false));
    });
    if (ok) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  return client;
}

/** A fake extension: answers the challenge with `code`. Resolves with what happened. */
function fakeExtension(port, code, { origin = ORIGIN, answer = true, onRequest } = {}) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, { origin });
    const clientNonce = randomToken();
    const seen = { welcome: false, serverProofOk: false, denied: null, closed: null, requests: [] };
    let serverNonce = "";
    ws.on("message", async (data) => {
      const m = JSON.parse(data);
      if (m.type === "challenge" && answer) {
        serverNonce = m.nonce;
        ws.send(
          JSON.stringify({
            type: "auth",
            nonce: clientNonce,
            proof: await proof(code, "extension", serverNonce, clientNonce),
          }),
        );
      } else if (m.type === "welcome") {
        seen.welcome = true;
        seen.serverProofOk = await checkProof(code, "server", serverNonce, clientNonce, m.proof);
        resolve({ ws, seen });
      } else if (m.type === "denied") seen.denied = m.reason;
      else if (m.method) {
        seen.requests.push(m.method);
        onRequest?.(ws, m);
      }
    });
    ws.on("close", (c) => {
      seen.closed = c;
      resolve({ ws, seen });
    });
    ws.on("unexpected-response", (_req, res) => resolve({ ws, seen: { ...seen, rejected: res.statusCode } }));
    ws.on("error", () => {});
  });
}

const CODE = newCode();
const PORT = 47700 + Math.floor(Math.random() * 200);
let mcp;
before(async () => (mcp = await startServer(CODE, PORT)));
after(async () => mcp?.close());

const text = (r) =>
  r.content
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");

test("an extension with the wrong code is turned away, and gets no requests", async () => {
  const { seen } = await fakeExtension(PORT, newCode());
  assert.equal(seen.welcome, false);
  assert.equal(seen.denied, "wrong-code");
  assert.equal(seen.closed, 4401);
  assert.deepEqual(seen.requests, []);
  const r = await mcp.callTool({ name: "drex_tabs", arguments: {} });
  assert.ok(r.isError);
  assert.match(text(r), /pairing code doesn't match/);
});

test("a connection that never proves the code is closed after a few seconds", async () => {
  const { seen } = await fakeExtension(PORT, CODE, { answer: false });
  assert.equal(seen.denied, "timeout");
  assert.equal(seen.closed, 4401);
});

test("a web page can't connect at all (origin check)", async () => {
  const { seen } = await fakeExtension(PORT, CODE, { origin: "https://evil.example" });
  assert.equal(seen.rejected, 401);
});

test("the paired extension gets the request, the server proves the code back, and the tool returns the answer", async () => {
  const { ws, seen } = await fakeExtension(PORT, CODE, {
    onRequest: (sock, m) =>
      sock.send(
        JSON.stringify({ id: m.id, result: [{ tab_id: 7, title: "Test", url: "http://127.0.0.1/", active: true }] }),
      ),
  });
  assert.ok(seen.welcome && seen.serverProofOk);
  const r = await mcp.callTool({ name: "drex_tabs", arguments: {} });
  assert.ok(!r.isError, text(r));
  assert.match(text(r), /"tab_id": 7/);
  assert.deepEqual(seen.requests, ["tabs"]);
  ws.close();
});

test("a server started without a pairing code refuses every extension and every tool call", async () => {
  const port = PORT + 300;
  const bare = await startServer("", port);
  try {
    const { seen } = await fakeExtension(port, CODE);
    assert.equal(seen.denied, "unpaired-server");
    const r = await bare.callTool({ name: "drex_tabs", arguments: {} });
    assert.ok(r.isError);
    assert.match(text(r), /no pairing code/);
  } finally {
    await bare.close();
  }
});

test("a call in flight on a connection that a newer one replaces fails at once instead of hanging", async () => {
  const first = await fakeExtension(PORT, CODE); // paired, but never answers requests
  assert.ok(first.seen.welcome);
  const call = mcp.callTool({ name: "drex_tabs", arguments: {} });
  await new Promise((r) => setTimeout(r, 300)); // the request is out on the first connection
  const second = await fakeExtension(PORT, CODE);
  const t0 = Date.now();
  const r = await call;
  assert.ok(r.isError);
  assert.match(text(r), /disconnected during the call/);
  assert.ok(Date.now() - t0 < 3000);
  second.ws.close();
});
