# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).
Each entry names the part it changes: the Chrome extension or the local runner (`nace-browser`).

## [0.1.2] - 2026-10-21

### Fixed

- **Chrome extension**: when a task spells out the JSON object its answer must be, the final answer is that one object
  with every field; a bare list of the values, or the object inside a list, is written again in the format.
- **Chrome extension**: typing into a form text area replaces what it holds instead of adding to it. Document editors
  still get new text at the end.
- **Chrome extension**: fewer approval cards on harmless clicks. A menu item that only opens a submenu, a search's own
  counts and filter chips ("Remove guests"), "by post" and dragging a slider no longer ask; sending, paying, posting
  and deleting still do.
- **Chrome extension**: a form fill no longer fails on an empty placeholder entry.
- **Chrome extension**: the agent may set a URL parameter the site's own links already use (a filter, sort, price
  range or page size), and a page that asks for an answer gets it on the page.

### Added

- **Chrome extension**: an `unattended` setting for runners with nobody at the panel: a run that would hand over ends
  with an answer in the task's format instead, and a choice it can't make counts as a failed step. `e2e/run.py
  --unattended` sets it.

## [0.1.1] - 2026-10-20

### Fixed

- **Chrome extension**: a run that collects data and then writes it into a page (for example a Google Sheet) now hands
  that page the collected records as a table, and types the whole table into the sheet at once instead of cell by cell.
  A one-line input refuses a multi-line table instead of mangling it.
- **Chrome extension**: a step the LLM's check finds already done counts as done, so a finished run no longer fails
  its last check; a check's repair never pulls a later step forward.
- **Chrome extension**: a tab the agent opens on another site gets its own index in the plan, so a step aimed at the
  user's tab never lands on the agent's.
- **Chrome extension**: when the agent reuses one of its own tabs, its old page is no longer taken for the page a
  planned URL opened.

### Added

- `e2e/run.py --profile` runs a browser test in a kept Chrome profile, for sites that need a login made once by hand.

## [0.1.0] - 2026-10-20

The first public release of the source of Drex Browser Use. Nothing is published to npm or the Chrome Web Store: build the runner and the
extension from a checkout, as the README describes.

### Added

- **Local runner** (`runner/`, version 0.1.0): the `nace-browser` CLI (`run`, `login`, `profiles`, `install`) and an
  MCP server over stdio with the tools `browser_task`, `browser_login` and `browser_profiles`. It drives Playwright's
  Chromium on browser profiles of its own, denies recognized risky clicks by default, never types credentials, and
  returns a JSON result with the answer, the outcome, the steps and the cost.
- **Chrome extension** (`src/`, version 0.1.0): a side panel that runs tasks in your own Chrome, with approval cards
  for risky clicks, a live view, run limits and a downloadable run log. It can be paired with a local coding agent
  through the MCP server in `mcp/`. A paired agent sees only the tabs its own runs opened or worked in, and its runs
  always stop at a risky step, whatever the panel's approval setting.
- The agent: Drex Max takes the actions; an LLM helps: it plans, reads and checks. Claude Haiku 5.5 by default, or
  another model from Anthropic, OpenAI, Google Gemini, OpenRouter or Fireworks.
- A Claude Code plugin (`plugins/nace-browser`) with the MCP server and a skill about when to use the browser.
- A README with a demo of a real run, WebArena-Verified and MiniWoB++ results against Claude Code and Codex with the
  model cost of 1,000 tasks, and the models on offer. Its images are rendered from `docs/assets/src/benchmarks.json` by
  `scripts/readme-assets.mjs`.
- Docs for the runner, the MCP tools, keys, the extension's settings, privacy and evals; security and contribution
  policies; issue and pull request templates; a CI workflow that builds, checks and tests every pull request.
- Synthetic end-to-end test pages (`e2e/site/`) and unit and browser tests.

### Known limitations

- Accuracy: 73% on WebArena-Verified shopping development tasks ([docs/evals.md](docs/evals.md)).
- Risky-click detection reads control names against a list of English words.
- Cloud runs are not available.
