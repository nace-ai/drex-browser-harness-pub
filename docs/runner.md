# Local runner: `nace-browser`

The runner lets a coding agent use the Drex Browser Use agent. It starts Playwright's Chromium with a release build of the
Drex Browser Use extension, on a browser profile of its own, and runs the task in the extension exactly as a run from the
side panel does. Drex Max picks each move; the LLM (Claude Haiku 5.5 by default) plans, reads and checks.

It has two front ends over the same run:

- a CLI, `nace-browser run "task" --url URL --json`, for any agent that can run a shell command;
- an MCP server over stdio, `nace-browser mcp`, with the tools `browser_task`, `browser_login` and `browser_profiles`.

The runner is not on npm: build it from a checkout of this repository. Its source is in [`runner/`](../runner).

## Install

You need Node 22.18 or later, npm and git.

```bash
git clone https://github.com/nace-ai/drex-browser-harness-pub.git drex-browser
cd drex-browser
npm ci
npm run build:release                      # writes runner/extension/: the release build, with no keys and no local paths
node runner/bin/nace-browser.mjs install   # Playwright's Chromium, once (about 170 MB); --with-deps on a bare Linux box
npm link -w runner                         # optional: puts `nace-browser` and `drex-browser-run` on your PATH
```

`npm link -w runner` links the checkout into npm's global folder, so `nace-browser` works from any directory and
picks up a rebuilt checkout. `npm unlink -g @nace-ai/browser` removes it. Without it, run
`node <checkout>/runner/bin/nace-browser.mjs` wherever this page says `nace-browser`.

To update, run `git pull`, `npm ci` and `npm run build:release` again.

Branded Google Chrome no longer loads an unpacked extension from the command line, so the runner always uses
Playwright's Chromium.

## Keys

The runner reads keys only from the environment of the process that starts it:

| Variable | What it is |
| --- | --- |
| `DREX_API_KEY` | A Drex API key from [console.nace.ai](https://console.nace.ai/dashboard/api-keys). New accounts get free credit. |
| `ANTHROPIC_API_KEY` | The key for the default LLM, Claude Haiku 5.5. |

Other LLMs are available on the CLI with `--model` (a model id from `src/models.ts`; an unknown one ends in
`run_refused`), with their provider's usual variable: `OPENAI_API_KEY`, `GOOGLE_API_KEY` or `GEMINI_API_KEY`,
`OPENROUTER_API_KEY`, or `FIREWORKS_API_KEY`. Accuracy was measured with Claude Haiku 5.5. MCP runs always use the
default model, so they need `ANTHROPIC_API_KEY`.

The runner hands the keys to the extension with each run. They are never written to the profile's storage, the run
artifacts or the build, and keys saved in a profile (for example through a headed run's side panel) are ignored.

**Set the keys in your shell profile, and let your agent pass them to the server.** Do not paste them into an MCP
config file, a project file or a command line: config files are plain text that is easy to commit or share, and
command lines end up in your shell history. [auth.md](auth.md) shows how to keep them in your OS keychain.

## Agents

In the snippets below, replace `/ABS/PATH/drex-browser` with the absolute path of your checkout (`pwd` in it prints
it). A run takes from a few seconds to a few minutes, so give tool calls a long timeout (Codex's default is 60 s).

### Claude Code

Claude Code passes its environment to the MCP servers it starts, so start it from a shell where the keys are set:

```bash
claude mcp add --scope user nace-browser -- node /ABS/PATH/drex-browser/runner/bin/nace-browser.mjs mcp
```

Or, after `npm link -w runner`, install the plugin from this repository. It adds the same server (as `nace-browser
mcp`) and a short skill that tells Claude when to reach for the browser, and when not to:

```bash
claude plugin marketplace add nace-ai/drex-browser-harness-pub
claude plugin install nace-browser@drex-browser
```

### Codex

Codex passes only the variables named in `env_vars` to a server. `~/.codex/config.toml`:

```toml
[mcp_servers.nace-browser]
command = "node"
args = ["/ABS/PATH/drex-browser/runner/bin/nace-browser.mjs", "mcp"]
env_vars = ["DREX_API_KEY", "ANTHROPIC_API_KEY"]
tool_timeout_sec = 900
```

### Cursor

`~/.cursor/mcp.json` (or `.cursor/mcp.json` in a project). `${env:NAME}` reads the variable from Cursor's environment,
so the file holds no key:

```json
{
  "mcpServers": {
    "nace-browser": {
      "command": "node",
      "args": ["/ABS/PATH/drex-browser/runner/bin/nace-browser.mjs", "mcp"],
      "env": { "DREX_API_KEY": "${env:DREX_API_KEY}", "ANTHROPIC_API_KEY": "${env:ANTHROPIC_API_KEY}" }
    }
  }
}
```

On macOS, Cursor started from the Dock may not see variables from your shell profile; start it from a shell
(`cursor .`) in that case.

### Hermes

Hermes passes only the variables listed under `env` to a server, and `${NAME}` reads them from its environment or
`~/.hermes/.env`. `~/.hermes/config.yaml`:

```yaml
mcp_servers:
  nace-browser:
    command: node
    args: ["/ABS/PATH/drex-browser/runner/bin/nace-browser.mjs", "mcp"]
    env:
      DREX_API_KEY: "${DREX_API_KEY}"
      ANTHROPIC_API_KEY: "${ANTHROPIC_API_KEY}"
    timeout: 900
```

### Pi, and any agent without MCP

Use the CLI with `--json`: standard output holds only the result. Tell the agent about it once, for example in
`AGENTS.md`:

```markdown
For a task on a web page that needs a real browser (clicking, forms, pages behind navigation), run
`nace-browser run "<task>" --url <start page> --json` and read `status`, `answer_text` and `outcome`.
It can change or delete site data; the risky-click guard is best-effort, not a safety boundary. Use it only
for tasks and accounts where I authorize those effects. If `outcome.kind` is `blocked_login` or `blocked_captcha`, ask me
to run `nace-browser login <url>`.
```

Without `npm link -w runner`, write `node /ABS/PATH/drex-browser/runner/bin/nace-browser.mjs` instead of
`nace-browser`.

## CLI

```
nace-browser install [--with-deps]
nace-browser run "task" --url URL [--json] [--headed] [--profile NAME | --temp-profile]
                 [--max-cost USD] [--max-seconds N] [--max-llm-calls N] [--model M] [--allow-risky]
                 [--out DIR] [--quiet]
nace-browser login URL [--profile NAME]
nace-browser profiles [--json]
nace-browser mcp
nace-browser --version | help
```

- Without `--profile`, `run` and `login` use the profile `default`. A profile name has letters, digits, `-` and `_`,
  starts with a letter or digit, and is at most 64 characters. The task is at most 4,000 characters.
- `run` is headless unless `--headed`. Progress (the plan, each step, each move) goes to stderr; `--quiet` turns it off.
- Limits default to the extension's: $0.04 of model cost for Haiku (scaled to the model's price for others), 600 s
  and 20 LLM calls. A person can raise them on the CLI
  up to Drex's API caps ($1, 1,800 s, 100 calls). An agent on MCP can only lower the cost and time limits
  (`max_cost_usd`, `max_seconds`); its runs always get 20 LLM calls.
- `--temp-profile` runs on a fresh profile that is deleted when the run ends, on every way out (Ctrl-C, SIGTERM and
  SIGHUP included). Use it in sandboxes and for one-off runs. Named profiles are never deleted. Temporary profiles go in
  the OS temp directory, or in `NACE_BROWSER_TMP`. The result's `profile` is `null` for them.
- Artifacts go to `~/.nace/browser/runs/<run id>/` unless `--out`: `run.json` (the extension's full run log, the same
  file as the side panel's "Download run log") once the run has started, `final.png` (the agent's tab at the end, or
  `final.png`/`final.jpg` from the extension's own screenshot) when one could be taken, and always `result.json`.
- `login` returns when the person closes the window, or after 15 minutes; `browser_login` returns
  `{"profile", "url", "ended", "profile_path"}`, `ended` being `closed`, `timeout` or `cancelled`.
- `profiles --json` and `browser_profiles` return `{"profiles": [{"name", "path", "in_use", "last_used"}]}`;
  `last_used` is when the profile directory last changed (ISO 8601). `in_use` is true while a process on this machine
  holds the profile's lock, or when another machine wrote the lock (it can't be checked from here).
- MCP runs are headless; `NACE_BROWSER_HEADED=1` in the server's environment shows their window. A client that sends a
  `progressToken` with `browser_task` gets the progress lines as `notifications/progress`.

Exit codes: `0` the run succeeded; `1` it ended `partial`, `failed`, `timed_out` or `cancelled` (the result is still
printed); `2` a usage error; `3` the run could not start (keys, browser, a busy profile), or `install` or `login`
failed or `login` was cancelled (`login` exits `0` when the window was closed or after its 15 minutes). With `--json`, a run that could not start prints `{"error": {"type": "runner_error", "code", "message"}}`
with one of the codes `missing_keys`, `extension_missing`, `extension_has_keys`, `browser_missing`, `browser_failed`,
`profile_busy`, `busy`, `run_refused`, `cancelled`, or `runner_error` for anything unexpected (a system error's own code, such as `EACCES`, is never passed on); a usage error prints
the same envelope with `invalid_request`. `login` and `browser_login` can also fail with `no_display` (Linux without
a display: a sandbox can't sign in). `login` exits `0` when the window closes or its 15-minute limit expires,
and `3` when cancelled. A second Ctrl-C, SIGTERM or SIGHUP, or 120 s after the first, exits at once with
130, 143 or 129. For `mcp`, the first signal cancels the running tools and the server exits, with 130, 143 or 129,
when they have ended; a client hanging up ends it with `0`.

## The result

`run --json` and `browser_task` return the shape Drex's browser runs API uses for a run, so code that reads a
local run will read a cloud run the same way once cloud runs are available:

```json
{
  "id": "lrun_mvgamik3f916f9a5",
  "object": "browser_run",
  "mode": "local",
  "status": "succeeded",
  "task": "Register Ada Lovelace, ada@example.com, from Kazakhstan, with a student ticket, accepting the code of conduct. Tell me the confirmation the page shows.",
  "start_url": "http://127.0.0.1:8901/form.html",
  "answer": null,
  "answer_text": "Registered: {\"name\":\"Ada Lovelace\",\"email\":\"ada@example.com\",\"country\":\"Kazakhstan\",\"ticket\":\"student\",\"terms\":true}",
  "outcome": {
    "kind": "completed",
    "reason": null,
    "evidence": [{ "url": "http://127.0.0.1:8901/form.html", "text": "…the confirmation text matches the requested values…" }]
  },
  "final_url": "http://127.0.0.1:8901/form.html",
  "steps": [
    { "n": 1, "kind": "fill", "goal": "On the open registration form, set Name to Ada Lovelace, …", "moves": 5, "result": "done" },
    { "n": 2, "kind": "browse", "goal": "Submit the completed registration form once …", "moves": 2, "result": "done" },
    { "n": 3, "kind": "read", "goal": "Read and quote exactly the confirmation text …", "moves": 0, "result": "done" }
  ],
  "usage": {
    "drex_input_tokens": 6800,
    "llm_input_tokens": 23589,
    "llm_output_tokens": 2455,
    "drex_calls": 2,
    "llm_calls": 4,
    "browser_seconds": 24,
    "cost_usd": 0.00325
  },
  "model": "claude-haiku-5-5",
  "profile": "smoke",
  "artifacts": [
    { "kind": "run_log", "path": "/home/me/.nace/browser/runs/lrun_mvgamik3f916f9a5/run.json" },
    { "kind": "screenshot", "step": null, "path": "/home/me/.nace/browser/runs/lrun_mvgamik3f916f9a5/final.png" },
    { "kind": "result", "path": "/home/me/.nace/browser/runs/lrun_mvgamik3f916f9a5/result.json" }
  ],
  "created_at": "2026-10-20T06:19:27.987Z",
  "started_at": "2026-10-20T06:19:28.546Z",
  "finished_at": "2026-10-20T06:19:53.181Z"
}
```

- `answer` is the structured answer an `answer_schema` asks for. The runner takes no schema yet, so it is `null` and
  the answer is in `answer_text`, as on the API without a schema. A run that did not finish puts what it had found in
  `answer_text`, as JSON: `{"complete": false, "reason", "observed_evidence"}`.
- Artifacts carry a local `path` where the API has a signed `url`.
- `usage.cost_usd` is the model cost the extension metered (Drex Max and the LLM at list prices), not a Drex bill.

`outcome.kind` and `status`:

| `outcome.kind` | `status` | When |
| --- | --- | --- |
| `completed` | `succeeded` | The run finished its plan. |
| `blocked_login` | `partial` | A sign-in screen, or another hand-over only a person can do. Run `nace-browser login`. |
| `blocked_captcha` | `partial` | A CAPTCHA or "are you human" check on screen (an invisible reCAPTCHA's badge or a hidden widget doesn't count). |
| `risky_action_denied` | `partial` | The next move needed approval: a click recognized as send, pay, delete, publish or order, a screen-point click whose target is risky or unknown, or a non-hover gesture, or a bulk action over list items (`reason` names it). |
| `limit_reached` | `partial` | A run limit ran out: cost, time or LLM calls, or a request's cost could not be metered. |
| `site_error` | `failed` | The agent gave up: the steps kept failing on this site, or the start page didn't load. |
| `internal_error` | `failed` | The run itself failed (a model or key error, for example). |
| `timed_out` | `timed_out` | The runner stopped a run 60 s past its time limit. |
| `cancelled` | `cancelled` | Ctrl-C, SIGTERM, SIGHUP, the MCP client cancelled the call, or Stop in a headed run's panel. |

`not_found` (on the API) is not reported yet: the harness has no signal for it, so such runs end `completed` with the
finding in `answer_text`.

## Safety

- **The risky-click guard is best-effort.** By default, the extension's "Ask before risky actions" is on and nobody
  is at the browser to ask. A click recognized as risky, a screen-point click whose target is risky or unknown, a non-hover gesture, or a bulk action
  over list items ends the run `risky_action_denied` before that move.
  This is a heuristic, not a safety boundary: unrecognized labels and forms submitted with Enter can still send,
  pay, delete, publish or order. Use only tasks and signed-in accounts where you authorize those effects.
  `--allow-risky` (CLI only; the MCP tools have no such option) disables even this guard for one run. The MCP server
  marks `browser_task` `destructiveHint: true`; `browser_login` is not destructive and `browser_profiles` is read-only.
- **No credentials are typed.** A sign-in or CAPTCHA screen ends the run (`blocked_login`, `blocked_captcha`). The
  person signs in once with `nace-browser login URL` (or `browser_login`): a visible window on the profile, closed by
  them when they're done. Later runs on that profile are signed in.
- **One run per profile.** A lock file (`~/.nace/browser/profiles/<name>.lock`) holds a profile for one process. A
  lock whose process is gone on this machine is taken over; one written on another machine (a shared
  `NACE_BROWSER_HOME`) never is: the `profile_busy` message names the lock file to delete. A lock with the runner's
  own pid that it didn't take (a restarted container) is taken over too; one whose pid now belongs to another program
  counts as held until it is deleted. When two processes find the same stale lock at once, one takes it and the other
  reports `profile_busy`. When an earlier takeover was interrupted (a `<name>.lock.takeover` over 10 s old), the call
  removes it and reports `profile_busy`; running it again takes the profile. `profile_busy` also means another
  Chromium has the profile directory open. Use another `--profile`, or `--temp-profile`, for parallel runs.
- **Profiles are yours.** They live in `~/.nace/browser/profiles/<name>` (`NACE_BROWSER_HOME` moves `~/.nace/browser`).
  A profile that is signed in to a site gives every run on it that session: keep separate profiles for separate trust.

## How it works

1. `nace-browser run` checks the keys and the extension build, takes the profile's lock (or makes a temporary
   profile), and starts Chromium with `--load-extension` and no viewport emulation: a real 1280×800 window, so the
   agent's screenshots match the page (the same setup as `e2e/run.py`). It waits up to 60 s for the extension's
   service worker, which can take over 15 s to start on a busy machine.
2. It opens the start URL in the first tab, then the extension's panel page in a second tab, and brings the start tab
   to the front so the run starts there.
3. From the panel page it connects to the worker on the panel's port and sends `{type: "run", task, over}`. `over`
   carries this run's keys, model, limits, approvals (on unless `--allow-risky`) and a report request, so nothing is written to
   `chrome.storage`. The worker runs the task as it runs a panel task. With a report requested, a hand-over or
   approval ends the run (nobody is at this browser) and the end screen is reported.
4. It prints the run's events as progress, stops the run if it goes 60 s past its time limit, then asks the worker for
   the finished run (the same object the panel's "Download run log" saves) and maps it to the result above.

`--json` keeps stdout to the JSON alone, and nothing reads a TTY. The package's separate `drex-browser-run` entry is
for cloud runs, which are not available yet ([worker.md](worker.md)).

## Development

- `npm run build:release` writes `runner/extension/`: no keys, no `bridge.local.json`, no sourcemaps. The build fails
  if the output holds a `*.local.json`, anything shaped like an API key, or the building machine's home directory.
  `npm pack` in `runner/` runs it first (`prepack`), so the package always ships a clean build. It also refuses a
  `runner/protocol/` schema whose checksum differs from `source.json` (re-import it from Drex with
  `node scripts/sync-browser-protocol.mjs /path/to/drex`), and records the git SHA and dirty state in
  `runner/build-info.json`. The package's `drex-browser-run` cloud worker is described in [worker.md](worker.md); its
  tests are `test/worker-*.test.mjs` and `test/hosted-budget.test.mjs` (the browser one is skipped without Playwright's Chromium and a release build).
- `NACE_BROWSER_EXTENSION=dist` runs the runner on the dev build instead, if it was built without an `.env`: the runner
  refuses a build with `keys.local.json` (`extension_has_keys`), since the extension would save those keys into the
  profile.
- Tests: `test/runner-*.test.mjs` (arguments, the result mapping, what a run sends the extension, the release guard,
  profile locks and temporary profiles, the CLI's stdout and exit codes, the MCP tools). `test/runner-e2e.test.mjs` runs two real tasks on `e2e/site` and is skipped without `DREX_API_KEY`,
  `ANTHROPIC_API_KEY`, Playwright's Chromium and a release build; `E2E_PORT` picks the test server's port. The
  tests in `test/runner-profiles.test.mjs` that start a run need a dev build in `dist/` (`npm run build`); the signal
  tests and the CAPTCHA test also need Playwright's Chromium (`node runner/bin/nace-browser.mjs install`). They are
  skipped without them.
