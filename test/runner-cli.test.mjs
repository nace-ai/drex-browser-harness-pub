// The CLI's contract for scripts and agents (runner/src/cli.mjs): with --json, stdout holds one JSON document and
// nothing else, and the exit code tells a usage error (2) from a run that could not start (3).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const BIN = new URL("../runner/bin/nace-browser.mjs", import.meta.url).pathname;

function cli(args, env = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nb-cli-"));
  // no keys from the machine running the tests: only what the test passes
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/_API_KEY$/.test(k)));
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [BIN, ...args], { env: { ...base, NACE_BROWSER_HOME: home, ...env } });
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    p.on("exit", (code) => {
      fs.rmSync(home, { recursive: true, force: true });
      resolve({ code, stdout, stderr });
    });
  });
}

test("a usage error with --json prints only an invalid_request error and exits 2", async () => {
  const r = await cli(["run", "t", "--url", "ftp://x", "--json"]);
  assert.equal(r.code, 2);
  assert.equal(JSON.parse(r.stdout).error.code, "invalid_request");
});

test("a run without keys prints only a missing_keys error and exits 3", async () => {
  const r = await cli(["run", "t", "--url", "https://example.com", "--json"]);
  assert.equal(r.code, 3);
  assert.deepEqual(Object.keys(JSON.parse(r.stdout)), ["error"]);
  assert.equal(JSON.parse(r.stdout).error.code, "missing_keys");
  const llm = await cli(["run", "t", "--url", "https://example.com", "--json"], { DREX_API_KEY: "nace_sk_test" });
  assert.equal(JSON.parse(llm.stdout).error.code, "missing_keys");
  assert.match(JSON.parse(llm.stdout).error.message, /ANTHROPIC_API_KEY/);
});

test("profiles --json prints the profile list", async () => {
  const r = await cli(["profiles", "--json"]);
  assert.equal(r.code, 0);
  assert.deepEqual(JSON.parse(r.stdout), { profiles: [] });
});
