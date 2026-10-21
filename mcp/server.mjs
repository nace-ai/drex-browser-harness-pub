#!/usr/bin/env node
// Drex for coding agents: an MCP server (stdio) that hands browser tasks to the Drex extension in your Chrome.
// The extension connects to ws://127.0.0.1:47615 while "Let coding agents use Drex" is on (the side panel doesn't
// have to be open); each tool call becomes a run you can watch in the panel.
//
// The link is paired: the extension and this server share a pairing code and prove it to each other before any
// request (src/pairing.ts), so only your own extension takes tasks from this server, and the extension only takes
// tasks from a server started with your code. Copy the setup command from the panel's settings; it looks like
//
//   claude mcp add drex -e DREX_PAIRING_CODE=... -- node /path/to/drex-browser/mcp/server.mjs
//   (Cursor, Codex, opencode, Gemini CLI...: the same command as a stdio MCP server, with that env variable)
//
// Env: DREX_PAIRING_CODE (required), DREX_BRIDGE_PORT (default 47615), DREX_EXTENSION_ID (accept only that extension).
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { WebSocketServer } from "ws";

if (!process.features.typescript) {
  console.error(
    `node at ${process.execPath} (${process.version}) can't run TypeScript, and this server imports src/pairing.ts. Install Node 22.18 or later.`,
  );
  process.exit(1);
}
const { PAIRING_VERSION, checkProof, proof, randomToken, validCode } = await import("../src/pairing.ts");

const PORT = Number(process.env.DREX_BRIDGE_PORT || 47615);
const EXTENSION_ID = process.env.DREX_EXTENSION_ID || "";
const CODE = (process.env.DREX_PAIRING_CODE || "").trim();
const CONNECT_WAIT_MS = 15000; // a tool call waits this long for the extension to (re)connect
const AUTH_WAIT_MS = 5000; // a connection that hasn't proved the code by then is closed
const RUN_TIMEOUT_MS = 20 * 60 * 1000;
const LOOK_TIMEOUT_MS = 30000;
const log = (...a) => console.error("[drex-mcp]", ...a); // stdout is the MCP channel
const UNPAIRED =
  "This Drex MCP server has no pairing code, so it won't talk to the extension. In Chrome, open the Drex " +
  "side panel (Alt+Shift+D), turn on 'Let coding agents use Drex' under the gear and copy the setup command: it adds " +
  "this server again with DREX_PAIRING_CODE set.";

// --- the extension link ---------------------------------------------------------------------------------------------
let ext = null; // the extension's socket, once it has proved the pairing code
let nextId = 1;
const pending = new Map(); // id -> {resolve, reject, timer, sock}
let listenError = "";
let refused = ""; // why the last connection was turned away, for the next tool call's error
let wrongCode = false; // the extension's code doesn't match: no point waiting for it until the server is set up again

function listen() {
  const wss = new WebSocketServer({
    host: "127.0.0.1",
    port: PORT,
    maxPayload: 32 * 1024 * 1024,
    // a web page can't connect: its origin is http(s), and it can't fake the Origin header (the pairing check below
    // is what keeps out other programs and other extensions)
    verifyClient: ({ origin }) =>
      EXTENSION_ID ? origin === `chrome-extension://${EXTENSION_ID}` : /^chrome-extension:\/\//.test(origin || ""),
  });
  wss.on("listening", () => {
    listenError = "";
    log(
      `waiting for the Drex extension on ws://127.0.0.1:${PORT}${validCode(CODE) ? "" : " (no pairing code: it will be turned away)"}`,
    );
  });
  wss.on("error", (e) => {
    listenError =
      e.code === "EADDRINUSE"
        ? `Port ${PORT} is taken, probably by another coding agent session using Drex. Close it, or give each session its own DREX_BRIDGE_PORT.`
        : String(e);
    log(listenError);
    setTimeout(listen, 5000); // take over when the other session ends
  });
  wss.on("connection", (sock) => {
    const serverNonce = randomToken();
    let authed = false;
    const send = (m) => sock.readyState === sock.OPEN && sock.send(JSON.stringify(m));
    const refuse = (reason, why) => {
      // only a code mismatch is worth telling the coding agent; a connection that just never answered (a port
      // scanner, a tab that closed) says nothing about the extension
      if (reason !== "timeout") {
        refused = why;
        wrongCode = true;
      }
      log(why);
      send({ type: "denied", reason });
      sock.close(4401, reason);
    };
    const timer = setTimeout(
      () => !authed && refuse("timeout", "A connection didn't prove the pairing code in time and was closed."),
      AUTH_WAIT_MS,
    );
    sock.on("message", async (data) => {
      let msg;
      try {
        msg = JSON.parse(data);
      } catch {
        return;
      }
      if (!authed) {
        if (msg.type !== "auth") return; // nothing else counts before the proof
        clearTimeout(timer);
        if (!validCode(CODE)) return refuse("unpaired-server", UNPAIRED);
        if (!(await checkProof(CODE, "extension", serverNonce, msg.nonce, msg.proof))) {
          return refuse(
            "wrong-code",
            "The Drex extension's pairing code doesn't match this server's DREX_PAIRING_CODE. " +
              "Copy the setup command from the panel's settings again (the code changes when you click New code).",
          );
        }
        authed = true;
        refused = "";
        wrongCode = false;
        send({ type: "welcome", v: PAIRING_VERSION, proof: await proof(CODE, "server", serverNonce, msg.nonce) });
        if (ext && ext !== sock) ext.close(); // the newest paired connection wins (a reloaded extension reconnects)
        ext = sock;
        log(`extension paired: ${msg.name || "drex-browser"} ${msg.version || ""}`);
        return;
      }
      if (msg.type === "ping") return send({ type: "pong" });
      const p = pending.get(msg.id);
      if (!p || p.sock !== sock) return; // an answer only counts on the socket the call went out on
      pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(msg.error));
      else p.resolve(msg.result);
    });
    sock.on("close", () => {
      clearTimeout(timer);
      if (!authed) return; // never paired: nothing was sent to it
      if (ext === sock) {
        ext = null;
        log("extension disconnected");
      }
      // calls sent on this socket can't be answered any more (a newer connection may have replaced it)
      for (const [id, p] of pending) {
        if (p.sock !== sock) continue;
        pending.delete(id);
        clearTimeout(p.timer);
        p.reject(
          new Error("The Drex extension disconnected during the call (Chrome closed, or the extension was reloaded)."),
        );
      }
    });
    send({ type: "challenge", v: PAIRING_VERSION, nonce: serverNonce });
  });
}

async function call(method, params, timeoutMs) {
  if (!validCode(CODE)) throw new Error(UNPAIRED);
  if (!ext && wrongCode) throw new Error(refused);
  for (let waited = 0; !ext && waited < CONNECT_WAIT_MS; waited += 250) await new Promise((r) => setTimeout(r, 250));
  if (!ext) {
    throw new Error(
      listenError ||
        refused ||
        "The Drex extension isn't connected. In Chrome, turn on 'Let coding agents use Drex' under the gear in the " +
          "Drex side panel (Alt+Shift+D), and check that this server was added with the setup command shown there.",
    );
  }
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`No answer from the extension in ${timeoutMs / 1000} s.`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer, sock: ext });
    ext.send(JSON.stringify({ id, method, params }));
  });
}

// --- MCP --------------------------------------------------------------------------------------------------------------
const TOOLS = [
  {
    name: "drex_run",
    description:
      "Do a task in a real Chrome browser (the user's own, signed in) and report back. Drex Max, a fast decision model, " +
      "makes each click and keystroke for a fraction of a cent, and a small LLM plans and writes text, so one call " +
      "replaces a long run of screenshot-and-click tool calls. Use it to check a web UI you are building (open the " +
      "page, go through the flow, tell what happens), to fill in forms, or to fetch information that needs clicking. " +
      "Write the task as the outcome to reach, in plain words. Give `url` to start on a page (e.g. your dev server), " +
      "and `expect` to have Drex check a statement about the end screen (you get the probability it holds). Returns " +
      "the status, what each move did, the end page, console errors and failed requests seen on the way, the cost, " +
      "and a screenshot of the end screen. Calls run one at a time (parallel calls queue), each from a fresh load of `url`. " +
      "When a step needs the person (a CAPTCHA, a login, approval of a risky click such as pay, send or delete), the run " +
      "ends with status needs_user and says what is needed. When the run's budget runs out (time, LLM calls or spend), " +
      "it ends with status partial and the answer holds what it found so far.",
    inputSchema: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description:
            "What to do, as the outcome to reach, e.g. 'Sign up with a new test account and open the settings page'.",
        },
        url: {
          type: "string",
          description:
            "Page to start on, e.g. http://localhost:3000/signup. Without it Drex starts on the active tab or finds the site itself.",
        },
        expect: {
          type: "string",
          description: "A statement about the end screen for Drex to check, e.g. 'An error says the email is invalid'.",
        },
        plan: {
          type: "boolean",
          description:
            "true: an LLM breaks the task into steps first (better for long tasks). false: Drex works on the task as written (cheaper, fine for short flows). Default: the panel's setting.",
        },
      },
      required: ["task"],
      additionalProperties: false,
    },
  },
  {
    name: "drex_screenshot",
    description:
      "Screenshot of a tab in the user's Chrome: by default the tab Drex last worked in. Free (no model call).",
    inputSchema: {
      type: "object",
      properties: { tab_id: { type: "number", description: "From drex_tabs." } },
      additionalProperties: false,
    },
  },
  {
    name: "drex_read_page",
    description:
      "Title, URL and readable text of a tab in the user's Chrome: by default the tab Drex last worked in. Free (no model call).",
    inputSchema: {
      type: "object",
      properties: { tab_id: { type: "number", description: "From drex_tabs." } },
      additionalProperties: false,
    },
  },
  {
    name: "drex_tabs",
    description: "The open tabs in the Chrome window you used last: id, title, URL, which one is active.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
];

/** A data: URL as MCP image content. */
function image(url) {
  const m = /^data:(image\/[\w+.-]+);base64,(.*)$/s.exec(url || "");
  return m ? [{ type: "image", mimeType: m[1], data: m[2] }] : [];
}

let runs = Promise.resolve(); // one browser, one run at a time: parallel drex_run calls (agents do send them) queue

async function runTool(name, args) {
  if (name === "drex_run") {
    const go = () =>
      call("run", { task: args.task, url: args.url, expect: args.expect, plan: args.plan }, RUN_TIMEOUT_MS);
    const mine = runs.then(go, go);
    runs = mine.catch(() => {});
    const r = await mine;
    const { screenshot, ...rest } = r;
    return [{ type: "text", text: JSON.stringify(rest, null, 1) }, ...image(screenshot)];
  }
  if (name === "drex_screenshot") {
    const r = await call("screenshot", { tab_id: args.tab_id }, LOOK_TIMEOUT_MS);
    return [{ type: "text", text: `Tab ${r.tab_id}: ${r.title} (${r.url})` }, ...image(r.screenshot)];
  }
  if (name === "drex_read_page") {
    const r = await call("read", { tab_id: args.tab_id }, LOOK_TIMEOUT_MS);
    return [
      {
        type: "text",
        text: `Tab ${r.tab_id}: ${r.title} (${r.url})${r.truncated ? ` [first ${r.text.length} of ${r.chars} characters]` : ""}\n\n${r.text}`,
      },
    ];
  }
  if (name === "drex_tabs")
    return [{ type: "text", text: JSON.stringify(await call("tabs", {}, LOOK_TIMEOUT_MS), null, 1) }];
  throw new Error(`Unknown tool ${name}`);
}

const server = new Server({ name: "drex", version: "0.1.2" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  try {
    return { content: await runTool(req.params.name, req.params.arguments || {}) };
  } catch (e) {
    return { content: [{ type: "text", text: e.message }], isError: true };
  }
});

listen();
await server.connect(new StdioServerTransport());
