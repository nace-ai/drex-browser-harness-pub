// The runner's command line (runner/src/args.mjs): what each command takes, the limits a run may have, and the
// errors a caller sees for a bad call.
import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_LIMITS, MAX_LIMITS, UsageError, limitsOf, parseCli } from "../runner/src/args.mjs";

test("run takes the task, the start URL and the documented options", () => {
  const cmd = parseCli([
    "run",
    "find the price",
    "--url",
    "https://shop.example.com/x",
    "--json",
    "--headed",
    "--profile",
    "work",
    "--max-cost",
    "0.02",
    "--max-seconds",
    "120",
    "--max-llm-calls",
    "8",
    "--model",
    "claude-sonnet-5-5",
    "--allow-risky",
    "--out",
    "runs/x",
  ]);
  assert.deepEqual(cmd, {
    command: "run",
    task: "find the price",
    url: "https://shop.example.com/x",
    json: true,
    headed: true,
    profile: "work",
    tempProfile: false,
    limits: { maxCostUsd: 0.02, maxSeconds: 120, maxLlmCalls: 8 },
    model: "claude-sonnet-5-5",
    allowRisky: true,
    out: "runs/x",
    quiet: false,
  });
});

test("a run is headless, on the default profile, with the extension's limits and risky actions denied", () => {
  const cmd = parseCli(["run", "task", "--url", "http://localhost:8000/"]);
  assert.equal(cmd.headed, false);
  assert.equal(cmd.profile, "default");
  assert.equal(cmd.allowRisky, false);
  // no cost limit: the extension scales its default to the model's price
  assert.deepEqual(cmd.limits, { maxSeconds: DEFAULT_LIMITS.maxSeconds, maxLlmCalls: DEFAULT_LIMITS.maxLlmCalls });
});

test("--temp-profile replaces the named profile and can't be combined with --profile", () => {
  const cmd = parseCli(["run", "task", "--url", "https://a.example/", "--temp-profile"]);
  assert.equal(cmd.tempProfile, true);
  assert.equal(cmd.profile, null);
  assert.throws(
    () => parseCli(["run", "task", "--url", "https://a.example/", "--temp-profile", "--profile", "x"]),
    /can't be used together/,
  );
});

test("bad runs are usage errors that say what to fix", () => {
  const bad = [
    [["run", "--url", "https://a.example/"], /needs a task/],
    [["run", "task"], /needs --url/],
    [["run", "task", "--url", "file:///etc/passwd"], /http or https/],
    [["run", "task", "--url", "not a url"], /http or https/],
    [["run", "two", "words", "--url", "https://a.example/"], /Quote the task/],
    [["run", "task", "--url", "https://a.example/", "--max-cost", "0"], /positive/],
    [["run", "task", "--url", "https://a.example/", "--max-seconds", "1.5"], /whole number/],
    [["run", "task", "--url", "https://a.example/", "--max-cost", "5"], /at most 1/],
    [["run", "task", "--url", "https://a.example/", "--profile", "../etc"], /Invalid profile name/],
    [["run", "task", "--url", "https://a.example/", "--bogus"], /Unknown option/],
    [["run", "x".repeat(4001), "--url", "https://a.example/"], /4,000/],
    [["fly"], /Unknown command/],
  ];
  for (const [argv, message] of bad)
    assert.throws(
      () => parseCli(argv),
      (e) => e instanceof UsageError && message.test(e.message),
      argv.join(" "),
    );
});

test("an agent's limits can only go down: the MCP server caps them at the defaults", () => {
  assert.deepEqual(limitsOf({ maxCost: 0.01 }, DEFAULT_LIMITS), { ...DEFAULT_LIMITS, maxCostUsd: 0.01 });
  assert.throws(() => limitsOf({ maxSeconds: 900 }, DEFAULT_LIMITS), /at most 600/);
  assert.deepEqual(limitsOf({ maxSeconds: 900 }), { maxSeconds: 900, maxLlmCalls: DEFAULT_LIMITS.maxLlmCalls }); // a person, on the CLI
  assert.throws(() => limitsOf({ maxLlmCalls: MAX_LIMITS.maxLlmCalls + 1 }), /at most 100/);
});

test("login, profiles, mcp, install, help and version", () => {
  assert.deepEqual(parseCli(["login", "https://mail.example.com", "--profile", "mail"]), {
    command: "login",
    url: "https://mail.example.com/",
    profile: "mail",
  });
  assert.throws(() => parseCli(["login"]), /needs the URL/);
  assert.deepEqual(parseCli(["profiles", "--json"]), { command: "profiles", json: true });
  assert.deepEqual(parseCli(["mcp"]), { command: "mcp" });
  assert.deepEqual(parseCli(["install", "--with-deps"]), { command: "install", withDeps: true });
  assert.deepEqual(parseCli([]), { command: "help" });
  assert.deepEqual(parseCli(["run", "--help"]), { command: "help" });
  assert.deepEqual(parseCli(["--version"]), { command: "version" });
});
