# MCP tools

`nace-browser mcp` starts an MCP server over stdio with three tools. Build and set it up as described in
[runner.md](runner.md). The same runs are available from the command line
with `nace-browser run --json`, for agents without MCP.

| Tool | What it does | Annotations |
| --- | --- | --- |
| [`browser_task`](#browser_task) | Runs one task in a real browser and returns the result | `destructiveHint: true`, `openWorldHint: true` |
| [`browser_login`](#browser_login) | Opens a visible window so a person can sign in to a site | `destructiveHint: false`, `openWorldHint: true` |
| [`browser_profiles`](#browser_profiles) | Lists the saved browser profiles | `readOnlyHint: true` |

## `browser_task`

Do a task in Chromium on this machine and return the answer, the outcome, the steps taken and the cost. It can change
or delete data on the sites it visits: use it only for tasks and accounts where the person accepts those effects.

### Arguments

| Name | Type | Required | Default | Rules |
| --- | --- | --- | --- | --- |
| `task` | string | yes | | What to do, in plain words, with the answer you want back. 1 to 4,000 characters. |
| `start_url` | string | yes | | The `http` or `https` page the run starts on. |
| `profile` | string | no | `default` | The saved browser profile to run on. Letters, digits, `-` and `_`, starting with a letter or digit, at most 64 characters. |
| `max_cost_usd` | number | no | the model's own limit | Stop at this model cost. An agent can lower it, not raise it. |
| `max_seconds` | integer | no | 600 | Stop after this many seconds. An agent can lower it, not raise it. |

There is no argument that allows risky actions: over MCP, the risky-action guard is always on. Runs are headless.

A client that sends a `progressToken` receives the plan, each step and each move as `notifications/progress`. A run takes
from a few seconds to a few minutes, so configure a tool timeout of several minutes (for example 900 seconds).

### Result

The result has the shape Drex's browser runs API uses for a run, with `mode: "local"`, a `profile`, and artifacts
that point to local files. It comes back both as
text (JSON) and as `structuredContent`.

```json
{
  "id": "lrun_…",
  "object": "browser_run",
  "mode": "local",
  "status": "succeeded",
  "task": "Register Ada Lovelace with a student ticket. Tell me the confirmation the page shows.",
  "start_url": "https://events.example.com/register",
  "answer": null,
  "answer_text": "Registered: Ada Lovelace, student ticket. Confirmation number EV-1042.",
  "outcome": {
    "kind": "completed",
    "reason": null,
    "evidence": [{ "url": "https://events.example.com/register/done", "text": "Thanks, Ada! Your confirmation number is EV-1042." }]
  },
  "final_url": "https://events.example.com/register/done",
  "steps": [
    { "n": 1, "kind": "fill", "goal": "Fill in the registration form", "moves": 5, "result": "done" },
    { "n": 2, "kind": "browse", "goal": "Submit the form", "moves": 2, "result": "done" },
    { "n": 3, "kind": "read", "goal": "Read the confirmation", "moves": 0, "result": "done" }
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
  "profile": "default",
  "artifacts": [
    { "kind": "run_log", "path": "~/.nace/browser/runs/lrun_…/run.json" },
    { "kind": "screenshot", "step": null, "path": "~/.nace/browser/runs/lrun_…/final.png" },
    { "kind": "result", "path": "~/.nace/browser/runs/lrun_…/result.json" }
  ],
  "created_at": "2026-10-20T06:19:27.987Z",
  "started_at": "2026-10-20T06:19:28.546Z",
  "finished_at": "2026-10-20T06:19:53.181Z"
}
```

| Field | Meaning |
| --- | --- |
| `status` | `succeeded`, `partial`, `failed`, `timed_out` or `cancelled`. Derived from `outcome.kind` (below). |
| `answer` | A structured answer when a schema asks for one. The local runner takes no schema yet, so it is `null`. |
| `answer_text` | The answer in words. A run that did not finish puts what it had found here, as JSON: `{"complete": false, "reason", "observed_evidence"}`. |
| `outcome.evidence` | Page facts the run checked: up to 20 `{url, text}` pairs. |
| `steps` | The plan's steps in order: `kind` (`browse`, `fill`, `read`, …), `goal`, the number of `moves`, and `result` (`done`, `partial`, `failed`, `stopped` or `replanned`). |
| `usage.cost_usd` | The model cost the run metered at list prices (Drex Max and the LLM). It is not an invoice. |
| `artifacts` | The run log, a final screenshot when one could be taken, and the result file, under `~/.nace/browser/runs/<run id>/`. |

| `outcome.kind` | `status` | When |
| --- | --- | --- |
| `completed` | `succeeded` | The run finished its plan. |
| `blocked_login` | `partial` | A sign-in screen, or another hand-over only a person can do. Ask the person to run `browser_login`. |
| `blocked_captcha` | `partial` | A CAPTCHA or "are you human" check. |
| `risky_action_denied` | `partial` | The next move needed approval: a click recognized as pay, send, delete, publish or order, a click at a bare screen point, or a bulk action over list items. `reason` names it. |
| `limit_reached` | `partial` | A cost, time or LLM-call limit ran out. |
| `site_error` | `failed` | The steps kept failing on this site, or the start page didn't load. |
| `internal_error` | `failed` | The run itself failed, for example a model or key error. |
| `timed_out` | `timed_out` | The runner stopped a run that went past its time limit. |
| `cancelled` | `cancelled` | The MCP client cancelled the call, or the server was stopped. |

The cloud API also has `not_found` ("the site has no such thing") and `answer_invalid`. The local runner does not report
them yet: a run that finds nothing ends `completed`, with the finding in `answer_text`.

## `browser_login`

Open a visible browser window on a saved profile so the person at this computer can sign in to a site. Returns when they
close the window, or after 15 minutes. Later `browser_task` runs on that profile are signed in. Call it after a run
ends `blocked_login`, and tell the person what to do in the window. The agent never sees or types the credentials.

| Name | Type | Required | Default | Rules |
| --- | --- | --- | --- | --- |
| `url` | string | yes | | The `http` or `https` page to sign in on. |
| `profile` | string | no | `default` | The profile to keep the session in. |

Result:

```json
{ "profile": "default", "url": "https://mail.example.com/", "ended": "closed", "profile_path": "~/.nace/browser/profiles/default" }
```

`ended` is `closed` (the person closed the window), `timeout` (15 minutes passed) or `cancelled`. It needs a display:
on a machine without one, such as a cloud sandbox, it fails with `no_display`.

## `browser_profiles`

List the saved profiles. No arguments.

```json
{
  "profiles": [
    { "name": "default", "path": "~/.nace/browser/profiles/default", "in_use": false, "last_used": "2026-10-20T06:19:53.000Z" }
  ]
}
```

`in_use` is true while a run holds the profile. `last_used` is when the profile directory last changed (ISO 8601).

## Profiles

- Profiles live in `~/.nace/browser/profiles/<name>`. `NACE_BROWSER_HOME` moves `~/.nace/browser`.
- One run per profile at a time, held by a lock file. A second run on a busy profile fails with `profile_busy`: use
  another profile for parallel runs.
- A profile signed in to a site gives every run on it that session. Keep separate profiles for separate trust, and
  delete a profile's folder to sign it out of everything.

## Errors

A call that cannot start a run returns `isError: true` with this envelope:

```json
{ "error": { "type": "runner_error", "code": "profile_busy", "message": "…" } }
```

| `code` | Meaning |
| --- | --- |
| `invalid_request` | An argument broke a rule above. |
| `missing_keys` | No Drex credentials or LLM key were found. Sign in, or set the keys in the server's environment ([auth.md](auth.md)). |
| `browser_missing` | Playwright's Chromium is not installed. Run `nace-browser install`. |
| `browser_failed` | Chromium did not start. |
| `extension_missing`, `extension_has_keys` | The packaged extension build is missing, or contains keys and was refused. Reinstall the package. |
| `profile_busy`, `busy` | Another run holds the profile, or the server is busy. |
| `run_refused` | The extension refused the run, for example an unknown model. |
| `no_display` | `browser_login` needs a display. |
| `cancelled` | The call was cancelled before the run started. |
| `runner_error` | Anything unexpected. |

## Command line

The same runs, for agents without MCP and for people:

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

- `--json` prints only the result above on standard output; progress goes to standard error.
- `--temp-profile` runs on a fresh profile that is deleted when the run ends.
- `--allow-risky` turns the risky-action guard off for one run. It exists only on the command line, for a person to
  choose; the MCP tools never offer it.
- A person can raise the limits on the command line, up to $1, 1,800 seconds and 100 LLM calls.
- Exit codes: `0` succeeded; `1` ended `partial`, `failed`, `timed_out` or `cancelled` (the result is still printed);
  `2` usage error; `3` the run could not start.
