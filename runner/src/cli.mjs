// nace-browser's commands. Exit codes: 0 the run succeeded (or the command worked), 1 the run ended partial, failed,
// timed out or cancelled (its result is still printed), 2 a usage error, 3 the run could not start (keys, browser,
// a busy profile; or install or login failed or was cancelled). With --json, stdout holds only the JSON: the result, or
// {error: {type, code, message}}.
import { spawn } from "node:child_process";
import { USAGE, UsageError, parseCli } from "./args.mjs";
import { login } from "./login.mjs";
import { keepTempCleanupLast, listProfiles } from "./profiles.mjs";
import { errorOf } from "./result.mjs";
import { codeOf, playwrightCli, runTask } from "./run.mjs";
import { version } from "./version.mjs";

const print = (value) =>
  process.stdout.write(`${typeof value === "string" ? value : JSON.stringify(value, null, 2)}\n`);
const say = (line) => process.stderr.write(`${line}\n`);

/** A human summary of a result, for runs without --json. */
export function summaryText(r) {
  const lines = [
    `status: ${r.status} (${r.outcome.kind}${r.outcome.reason ? `: ${r.outcome.reason}` : ""})`,
    `final page: ${r.final_url ?? "-"}`,
    `cost: $${r.usage.cost_usd.toFixed(4)}, ${r.usage.browser_seconds} s, ${r.steps.length} steps`,
  ];
  for (const a of r.artifacts) lines.push(`${a.kind}: ${a.path}`);
  lines.push("", r.answer_text || "(no answer)");
  return lines.join("\n");
}

/**
 * Ctrl-C, SIGTERM or SIGHUP cancels the run (it stops and its result is printed); a second one, or 120 s, exits at
 * once. SIGHUP too: with Playwright's handlers off, Node's default for it would exit without the exit hooks.
 * onFirst: what the first signal does (by default, abort the returned signal).
 */
function cancelOnSignals(onFirst) {
  // the exit hook still removes a temporary profile: after Playwright's, which kills Chromium, even when Chromium is
  // still starting (Playwright adds its hook at the spawn, before launch() returns and moves ours behind it)
  const exitNow = (code) => {
    keepTempCleanupLast();
    process.exit(code);
  };
  const controller = new AbortController();
  let hits = 0;
  const codes = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 };
  const onSignal = (sig) => {
    hits++;
    if (hits === 1) {
      say(`${sig}: stopping...`);
      if (onFirst) onFirst(codes[sig]);
      else controller.abort();
      // past the longest stop: up to 30 s for the worker to start, 30 s more for it to hear the stop again, the last
      // run, a 15 s screenshot, the close
      setTimeout(() => exitNow(codes[sig]), 120000).unref();
    } else exitNow(codes[sig]);
  };
  for (const sig of Object.keys(codes)) process.on(sig, onSignal);
  return controller.signal;
}

export async function main(argv) {
  let cmd;
  try {
    cmd = parseCli(argv);
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    const wantsJson = argv.includes("--json");
    if (wantsJson) print(errorOf("invalid_request", e.message));
    else say(e.message);
    return 2;
  }
  switch (cmd.command) {
    case "help":
      print(USAGE);
      return 0;
    case "version":
      print(version());
      return 0;
    case "install":
      return new Promise((resolve) => {
        const args = [
          playwrightCli(),
          "install",
          "--no-shell",
          "--no-remove",
          "chromium",
          ...(cmd.withDeps ? ["--with-deps"] : []),
        ];
        spawn(process.execPath, args, { stdio: "inherit" })
          .on("error", (e) => (say(e.message), resolve(3)))
          .on("exit", (code) => resolve(code === 0 ? 0 : 3));
      });
    case "profiles": {
      const profiles = listProfiles();
      if (cmd.json) print({ profiles });
      else if (!profiles.length) print("No profiles yet. `nace-browser login URL` or a run makes one.");
      else
        for (const p of profiles) print(`${p.name}${p.in_use ? " (in use)" : ""}  ${p.path}  last used ${p.last_used}`);
      return 0;
    }
    case "login":
      try {
        say(`Sign in to the site in the window, then close it. The session is kept in profile "${cmd.profile}".`);
        const r = await login(cmd, { signal: cancelOnSignals(), handleSignals: false });
        if (r.ended === "cancelled") {
          say("Login cancelled.");
          return 3;
        }
        say(r.ended === "timeout" ? "The window was open for 15 minutes and was closed." : "Saved.");
        return 0;
      } catch (e) {
        say(e.message);
        return 3;
      }
    case "mcp": {
      const { serve } = await import("./mcp.mjs");
      // a signal closes the server, which cancels the running tools (their browsers close, their locks are released);
      // with Playwright's own handlers the browsers would close under the runs and the server would keep running
      const server = await serve({ handleSignals: false });
      cancelOnSignals((code) => {
        process.exitCode = code;
        void server.close().catch(() => {});
        process.stdin.destroy(); // nothing left to read: the process ends when the cancelled runs have
      });
      return null; // the server runs until its client hangs up
    }
    case "run":
      try {
        const result = await runTask(cmd, {
          onProgress: cmd.quiet ? () => {} : say,
          signal: cancelOnSignals(),
          handleSignals: false, // cancelOnSignals stops the run; Playwright's handlers would close the browser under it
        });
        print(cmd.json ? result : summaryText(result));
        return result.status === "succeeded" ? 0 : 1;
      } catch (e) {
        if (cmd.json) print(errorOf(codeOf(e), e.message));
        else say(e.message);
        return 3;
      }
    default:
      return 2;
  }
}
