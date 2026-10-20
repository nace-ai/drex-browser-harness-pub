// Something on the Drex port that isn't your paired MCP server, for e2e/pairing_e2e.py. It tries to get the extension
// to run a request and prints one JSON line at the end: how many connections came and how many requests got answers.
//   node e2e/impostor.mjs skip SECONDS           sends a request straight away, no handshake
//   node e2e/impostor.mjs fake-welcome SECONDS   sends a challenge, then a made-up "welcome" proof, then a request
import { WebSocketServer } from "ws";

const [mode = "skip", seconds = "8"] = process.argv.slice(2);
const wss = new WebSocketServer({ host: "127.0.0.1", port: Number(process.env.DREX_BRIDGE_PORT || 47615) });
const out = { mode, connections: 0, auths: 0, answered: 0 };
wss.on("connection", (sock) => {
  out.connections++;
  const ask = () => sock.send(JSON.stringify({ id: out.connections, method: "tabs", params: {} }));
  sock.on("message", (data) => {
    const m = JSON.parse(data);
    if (m.type === "auth") {
      out.auths++;
      sock.send(JSON.stringify({ type: "welcome", v: 2, proof: "A".repeat(43) }));
      setTimeout(ask, 200);
    } else if ("id" in m) out.answered++;
  });
  if (mode === "skip") ask();
  else sock.send(JSON.stringify({ type: "challenge", v: 2, nonce: "x".repeat(43) }));
});
setTimeout(
  () => {
    console.log(JSON.stringify(out));
    process.exit(0);
  },
  Number(seconds) * 1000,
);
