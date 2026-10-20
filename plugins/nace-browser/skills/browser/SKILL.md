---
name: browser
description: When and how to use the nace-browser MCP tools (browser_task, browser_login, browser_profiles) to do a task in a real browser. Use for web pages that need clicking, typing, forms or reading behind navigation; not for plain fetches of public pages or APIs.
---

# The Drex browser

`browser_task` runs one task in a real Chromium on this machine: Drex Max makes the clicks and keystrokes, an LLM plans
and reads. A run takes seconds to a few minutes and costs up to $0.04 by default.

**Use it** when the answer needs a browser: clicking through a site, filling a form, a page that renders with
JavaScript, a site the person signed in to with `browser_login`, or checking what a web app does after a click.

**Don't use it** for what a plain request does: a public page's HTML, a JSON API, docs you can fetch. Those are faster
and free.

How to call it:
- Write `task` as you would to a person, with the answer you want back ("…and tell me the price").
- `start_url` is the page to start on. Use one `profile` per site or account if the person has several.
- Lower `max_cost_usd` or `max_seconds` for small tasks; you can't raise them.

The risky-click guard is best-effort, not a safety boundary. Unrecognized clicks and Enter can still send, pay,
delete or order. Use only tasks and accounts where the person authorizes those effects.

Reading the result: `status` and `outcome.kind` say how it ended, `answer_text` holds the answer, `final_url` the page
it ended on, and `artifacts` the run log and a final screenshot on disk.

- `risky_action_denied`: the next move needed approval: a click recognized as potentially sending, paying, deleting,
  publishing or ordering, a screen-point click whose target is risky or unknown, a non-hover gesture, or a bulk action over list items. It was not
  made. Tell the person what the run was about to do (`outcome.reason`); don't try to work around it.
- `blocked_login` or `blocked_captcha`: ask the person to sign in, then call `browser_login` with that site's URL and
  the same profile. It opens a window and returns when they close it (or after 15 minutes). Its `ended` is `closed`
  (they closed the window), `timeout` (15 minutes ran out; they may not have signed in) or `cancelled`. Run the task
  again after `closed`; after `timeout` or `cancelled`, ask the person whether they signed in first.
- `limit_reached`, `site_error`, `internal_error`: say what `answer_text` and `outcome.reason` show; retry only with a
  clearer task.
- `timed_out`, `cancelled`: say so; retry with a narrower task or a higher `max_seconds` if you lowered it.

A tool error holds `error.code` instead of a result: `missing_keys` (ask the person to set `DREX_API_KEY` and
`ANTHROPIC_API_KEY` where the MCP server starts), `profile_busy` (another run uses the profile, or another Chromium has it open: wait or use
another `profile`; if `error.message` names a process that is gone, retry once), `browser_missing` (ask them to run `nace-browser install`), `no_display` (this machine can't open a
sign-in window), `extension_missing` (no extension build: in a checkout, ask them to run `npm run build:release`, or to fix
`NACE_BROWSER_EXTENSION`), `extension_has_keys` (`NACE_BROWSER_EXTENSION` points at a dev build made with an `.env`:
ask them to unset it),
`browser_failed` (Chromium did not start), `busy` or `run_refused` (the extension refused the run: retry once),
`cancelled`, `invalid_request` (fix the arguments), `runner_error` (anything else: say what `error.message` shows).
Arguments outside the schema (`max_cost_usd` or `max_seconds` above their caps) get the MCP layer's validation
message instead.

`browser_login` returns `{profile, url, ended, profile_path}`: `ended` is `closed` (they closed the window), `timeout`
(15 minutes passed: the sign-in may not have finished) or `cancelled`.

Never put passwords or card numbers in `task`.
