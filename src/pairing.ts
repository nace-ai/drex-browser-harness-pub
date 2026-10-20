// Pairing between the extension and mcp/server.mjs, so that only your own Drex MCP server can give Drex tasks and
// the extension only takes tasks from it. Both sides hold the same pairing code (32 random bytes, made by the
// extension and copied into the MCP server's config once) and prove it to each other before any request:
//
//   server -> extension   {type: "challenge", nonce: S}
//   extension -> server   {type: "auth", nonce: C, proof: HMAC(code, "extension", S, C)}
//   server -> extension   {type: "welcome", proof: HMAC(code, "server", S, C)}   (or "denied", then the socket closes)
//
// The code itself never crosses the socket. Something else listening on the port can't make the server's proof, so
// the extension hangs up on it; another program or extension connecting to the server can't make the extension's.
// Fresh nonces on both sides make an old proof useless, and the role in each proof stops one being sent back as the
// other. Used by the service worker and by Node (both have Web Crypto), so no chrome.* here.

import type { AgentSetup } from "./types.ts";

export const PAIRING_VERSION = 2;
const enc = new TextEncoder();

const b64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

export function randomToken(bytes = 32): string {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return b64url(b);
}

/** A new pairing code: 32 random bytes as 43 URL-safe characters. */
export const newCode = (): string => randomToken(32);

export const validCode = (code: string | null | undefined): boolean => /^[A-Za-z0-9_-]{43}$/.test(code || "");

/** role: "extension" or "server"; serverNonce and clientNonce in that order for both roles. */
export async function proof(
  code: string,
  role: "extension" | "server",
  serverNonce: string,
  clientNonce: string,
): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(code), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const msg = enc.encode(`drex-pairing-v${PAIRING_VERSION}\n${role}\n${serverNonce}\n${clientNonce}`);
  return b64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, msg)));
}

/** Does `given` prove the code for this role and these nonces? Compared in constant time. */
export async function checkProof(
  code: string,
  role: "extension" | "server",
  serverNonce: string,
  clientNonce: string,
  given: unknown,
): Promise<boolean> {
  if (typeof given !== "string" || !validCode(code) || !serverNonce || !clientNonce) return false;
  const want = await proof(code, role, serverNonce, clientNonce);
  if (given.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0;
}

/** The command that adds the Drex MCP server to Claude Code with this code (other agents: the same env and command). */
export function setupCommand(code: string, serverPath = "/path/to/drex-browser/mcp/server.mjs"): string {
  return `claude mcp add drex -e DREX_PAIRING_CODE=${code} -- node ${serverPath}`;
}

/** How to add the Drex MCP server to each coding agent with this code: a command to run, or a file to add it to (and,
 * for Cursor, a link that installs it). node and server are full paths on this machine: Cursor, VS Code and Windsurf
 * started from the Dock don't see a shell's PATH. Agents that time out tool calls get a long timeout: a run takes 30 s
 * to a few minutes (opencode's default is 5 s, Codex's 60 s). Formats: Claude Code `claude mcp add`; Cursor and
 * Windsurf `mcpServers` files; Codex config.toml `[mcp_servers]`; VS Code `code --add-mcp`; Gemini CLI settings.json
 * `mcpServers`; opencode.json `mcp` (its published schema). */
export function agentSetups(
  code: string,
  { server = "/path/to/drex-browser/mcp/server.mjs", node = "node" }: { server?: string; node?: string } = {},
): AgentSetup[] {
  const env = { DREX_PAIRING_CODE: code };
  const stdio = { command: node, args: [server], env };
  const typed = { type: "stdio", ...stdio }; // Cursor's docs list the type as required; VS Code's example has it
  // a word for a shell: as it is when safe, else single-quoted (a repo under "~/My Projects/")
  const sh = (word: string): string => (/^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, "'\\''")}'`);
  const json = (value: unknown): string => JSON.stringify(value, null, 2);
  const base64 = (text: string): string => btoa(String.fromCharCode(...new TextEncoder().encode(text)));
  return [
    {
      id: "claude",
      label: "Claude Code",
      how: "Run this in a terminal.",
      text: `claude mcp add drex -e DREX_PAIRING_CODE=${code} -- ${sh(node)} ${sh(server)}`,
    },
    {
      id: "cursor",
      label: "Cursor",
      how: "Click Add to Cursor, or put this in ~/.cursor/mcp.json.",
      text: json({ mcpServers: { drex: typed } }),
      link: `cursor://anysphere.cursor-deeplink/mcp/install?name=drex&config=${encodeURIComponent(base64(JSON.stringify(typed)))}`,
    },
    {
      id: "codex",
      label: "Codex",
      how: "Add this to ~/.codex/config.toml.",
      text: `[mcp_servers.drex]\ncommand = ${JSON.stringify(node)}\nargs = [${JSON.stringify(server)}]\nenv = { DREX_PAIRING_CODE = ${JSON.stringify(code)} }\ntool_timeout_sec = 900`,
    },
    {
      id: "vscode",
      label: "VS Code (Copilot)",
      how: "Run this in a terminal (VS Code's code command).",
      text: `code --add-mcp ${sh(JSON.stringify({ name: "drex", ...typed }))}`,
    },
    {
      id: "windsurf",
      label: "Windsurf",
      how: "Put this in Windsurf's mcp_config.json: ~/.codeium/windsurf/mcp_config.json, or ~/.config/devin/mcp_config.json in newer versions.",
      text: json({ mcpServers: { drex: stdio } }),
    },
    {
      id: "gemini",
      label: "Gemini CLI",
      how: "Put this in ~/.gemini/settings.json.",
      text: json({ mcpServers: { drex: { ...stdio, timeout: 900000 } } }),
    },
    {
      id: "opencode",
      label: "opencode",
      how: "Put this in opencode.json (or ~/.config/opencode/opencode.json).",
      text: json({
        mcp: { drex: { type: "local", command: [node, server], environment: env, enabled: true, timeout: 900000 } },
      }),
    },
  ];
}
