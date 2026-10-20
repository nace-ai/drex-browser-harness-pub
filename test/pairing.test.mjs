import assert from "node:assert/strict";
import { test } from "node:test";
import { agentSetups, checkProof, newCode, proof, randomToken, setupCommand, validCode } from "../src/pairing.ts";

test("newCode: 43 URL-safe characters (32 bytes), different every time", () => {
  const a = newCode();
  const b = newCode();
  assert.ok(validCode(a) && validCode(b));
  assert.notEqual(a, b);
  assert.ok(!validCode("") && !validCode("short") && !validCode(`${a}=`) && !validCode(a.slice(1)));
});

test("a proof checks out for the same code, role and nonces", async () => {
  const code = newCode();
  const [s, c] = [randomToken(), randomToken()];
  assert.ok(await checkProof(code, "extension", s, c, await proof(code, "extension", s, c)));
  assert.ok(await checkProof(code, "server", s, c, await proof(code, "server", s, c)));
});

test("a proof fails with another code, the other role, swapped or new nonces", async () => {
  const code = newCode();
  const [s, c] = [randomToken(), randomToken()];
  const p = await proof(code, "extension", s, c);
  assert.equal(await checkProof(newCode(), "extension", s, c, p), false); // someone without your code
  assert.equal(await checkProof(code, "server", s, c, p), false); // the extension's proof sent back as the server's
  assert.equal(await checkProof(code, "extension", c, s, p), false);
  assert.equal(await checkProof(code, "extension", randomToken(), c, p), false); // an old proof, a new challenge
  assert.equal(await checkProof(code, "extension", s, c, p.slice(0, -1)), false);
  assert.equal(await checkProof(code, "extension", s, c, undefined), false);
  assert.equal(await checkProof("", "extension", s, c, p), false);
});

test("setupCommand carries the code and the server path", () => {
  const code = newCode();
  assert.equal(
    setupCommand(code, "/x/mcp/server.mjs"),
    `claude mcp add drex -e DREX_PAIRING_CODE=${code} -- node /x/mcp/server.mjs`,
  );
});

// every agent's setup carries the code and this machine's full paths (an app started from the Dock doesn't see a shell's
// PATH), and a long tool timeout where the agent has one (a run takes 30 s to a few minutes; opencode's default is 5 s)
test("agentSetups: one setup per coding agent, each with the code, the paths and a long timeout", () => {
  const code = newCode(),
    server = "/Users/me/drex-browser/mcp/server.mjs",
    node = "/opt/homebrew/bin/node";
  const setups = agentSetups(code, { server, node });
  assert.deepEqual(
    setups.map((s) => s.id),
    ["claude", "cursor", "codex", "vscode", "windsurf", "gemini", "opencode"],
  );
  for (const s of setups) {
    assert.ok(s.label && s.how && s.text, s.id);
    assert.ok(s.text.includes(code) && s.text.includes(server) && s.text.includes(node), s.id);
  }
  const by = Object.fromEntries(setups.map((s) => [s.id, s]));
  assert.equal(by.claude.text, `claude mcp add drex -e DREX_PAIRING_CODE=${code} -- ${node} ${server}`);
  const stdio = { command: node, args: [server], env: { DREX_PAIRING_CODE: code } };
  // Cursor's docs list type "stdio" as required, and VS Code's --add-mcp example has it
  assert.deepEqual(JSON.parse(by.cursor.text), { mcpServers: { drex: { type: "stdio", ...stdio } } });
  assert.deepEqual(JSON.parse(by.windsurf.text), { mcpServers: { drex: stdio } });
  assert.deepEqual(JSON.parse(by.gemini.text), { mcpServers: { drex: { ...stdio, timeout: 900000 } } });
  assert.deepEqual(JSON.parse(by.opencode.text), {
    mcp: {
      drex: {
        type: "local",
        command: [node, server],
        environment: { DREX_PAIRING_CODE: code },
        enabled: true,
        timeout: 900000,
      },
    },
  });
  assert.deepEqual(JSON.parse(by.vscode.text.match(/--add-mcp '(.*)'$/)[1]), { name: "drex", type: "stdio", ...stdio });
  assert.match(by.codex.text, /^\[mcp_servers\.drex\]$/m);
  assert.match(by.codex.text, /^tool_timeout_sec = 900$/m);
  // Cursor's install link carries the same server, base64-encoded
  const config = new URL(by.cursor.link).searchParams.get("config");
  assert.deepEqual(JSON.parse(Buffer.from(config, "base64").toString()), { type: "stdio", ...stdio });
  assert.match(by.cursor.link, /^cursor:\/\/anysphere\.cursor-deeplink\/mcp\/install\?name=drex&config=/);
});

// a path with a space or a quote (a repo under "~/My Projects/") still makes a command a shell runs as one argument
test("agentSetups: paths with spaces or quotes are shell-quoted in the commands", () => {
  const code = newCode(),
    server = "/Users/me/My Projects/it's/mcp/server.mjs",
    node = "/opt/homebrew/bin/node";
  const by = Object.fromEntries(agentSetups(code, { server, node }).map((s) => [s.id, s]));
  assert.equal(
    by.claude.text,
    `claude mcp add drex -e DREX_PAIRING_CODE=${code} -- ${node} '/Users/me/My Projects/it'\\''s/mcp/server.mjs'`,
  );
  assert.ok(by.vscode.text.includes(`it'\\''s`)); // the single-quoted JSON closes and reopens around the quote
  assert.equal(JSON.parse(by.cursor.text).mcpServers.drex.args[0], server);
});
