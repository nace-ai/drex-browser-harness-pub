// One MCP tool call the way a coding agent makes it: starts mcp/server.mjs over stdio (with DREX_PAIRING_CODE from
// the environment), waits WAIT seconds for the extension to pair, calls the tool and prints the result as JSON.
//   DREX_PAIRING_CODE=... node e2e/mcp_call.mjs TOOL '{"task": "..."}' [WAIT]
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const [tool, args = "{}", wait = "6"] = process.argv.slice(2);
const server = new URL("../mcp/server.mjs", import.meta.url).pathname;
const client = new Client({ name: "e2e", version: "0" });
await client.connect(
  new StdioClientTransport({ command: process.execPath, args: [server], env: process.env, stderr: "inherit" }),
);
await new Promise((r) => setTimeout(r, Number(wait) * 1000));
const t0 = Date.now();
const r = await client.callTool({ name: tool, arguments: JSON.parse(args) }, undefined, { timeout: 15 * 60 * 1000 });
const text = r.content
  .filter((c) => c.type === "text")
  .map((c) => c.text)
  .join("\n");
console.log(
  JSON.stringify({
    isError: !!r.isError,
    seconds: (Date.now() - t0) / 1000,
    text,
    images: r.content.filter((c) => c.type === "image").length,
  }),
);
await client.close();
