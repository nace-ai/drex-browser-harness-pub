# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).
Each entry names the part it changes: the Chrome extension or the local runner (`nace-browser`).

## [Unreleased]

## [0.1.6] - 2026-10-30

### Added

- **Chrome extension**: Loop mode, experimental, built with `DREX_MODE=loop npm run build`. One LLM conversation (Claude
  Haiku 5.5 by default) holds the whole task and returns one action a turn: show the page (`page`, or `look` with a
  screenshot), read data from it with JavaScript that is checked to only read (`read`, also over up to 8 pages), open an
  address (`goto`) on the run's site or a site the task names, have Drex Max carry out one concrete step of at most 6
  moves (`do`), have Drex Max decide many items (`pick`) or check a claim on the screen (`check`), click at a point
  (`point`) or drag from one point to another (`drag`) itself, and `answer`. `look`'s screenshot is in CSS pixels and
  its view gives each control's centre, so points are exact. The LLM clicks a listed control or types itself only after
  Drex Max hands a step back; `point` and `drag` are for what has no control for Drex to pick (a canvas, a shape, drag
  and drop), and a point, or the start of a drag, on a listed control (selects, rows and grid cells included) is refused
  until then. A drag of under 5 pixels is a point. A Drex failure no later call can mend (a rejected key, no credit, a
  model the key can't use, the service down through its retries) ends the run as an error instead of leaving the LLM to
  carry on alone. There is no planner and no rescue or replan step; a run ends after 30 turns. The LLM's own click or
  keystroke stays bound to the control it saw (its node and tab): a control that was replaced or removed is refused, and
  the LLM gets a fresh view of the page. Page text reaches the LLM inside per-run markers it is told not to take
  instructions from. The default mode is unchanged. See [Benchmarks](README.md#benchmarks).

### Changed

- **Chrome extension** and **local runner**: Drex Max is metered at $0.03 per million input tokens, its list price since
  28 October 2026 (it was $0.06), so shown costs and dollar run limits match what Drex bills.

### Security

- **Chrome extension**: Loop mode is for evaluation only. Its `read` code is written by the LLM and runs in the page's
  own JavaScript world, with the page's cookies and network access. It is only checked against a list of patterns, not
  sandboxed, and the check can be got round: a hostile page that steers the LLM, or a mistaken LLM, can make a read send
  requests as you on that site or send the page's text to another site. Multi-page reads also navigate the tab you are
  on. `npm run build:release` refuses Loop mode, so the runner and the MCP server never run it unless you point them at
  a dev build (`NACE_BROWSER_EXTENSION=dist`). Never use it signed in to an account you care about; use test sites and
  throwaway accounts, until reads run sandboxed, in their own tab, with the network blocked.

## [0.1.5] - 2026-10-26

### Added

- **Chrome extension**: `sortCheck`, on by default: a step that sorts a list by date ends only once the rows' dates run
  the asked way (newest or oldest first); a wrong order refuses "done" with a hint to sort the other way, at most twice a
  step. It makes no model call.
- **Chrome extension**: more optional accuracy switches, off by default and set at build time with `DREX_ACC`:
  - `aggregate`: a collect step's list rows are typed in code, and the count, total, mean, least, most, ranking or top N
    the task asks for is computed over every row read; a computed result carries the chosen rows with their links, ties
    are reported whole, and a total refuses a field the task leaves a part out of ("excluding shipping").
  - `listCoverage`: a collect step reads on until the rows read reach the count the list states.
  - `styleKeys`: the helper may press Control or Meta with b, i or u to bold, italicize or underline selected text.
  - `topNStop`: "the N most recent" reads the first N qualifying rows of a list proven in date order and only their
    details.
- **Chrome extension**: optional cost switches, off by default and set at build time with `DREX_COST`: `rescueOneImage`
  (the first help of a step on a screen with tagged controls gets the tagged screenshot alone) and `planCompact` (plan
  steps carry only the fields they set).

### Changed

- **Local runner**: the `drex-browser-run` cloud worker speaks protocol 2: it requires Drex's `funding` envelope,
  meters every provider call and sandbox second against it outside Chromium, and refuses protocol 1 configurations
  ([docs/worker.md](docs/worker.md)).
- **Chrome extension**: `navMap` is given to the planner only when a closed-menu entry of the site matches the task, and
  stays off by default.

### Fixed

- **Local runner**: cancelling a run while Chromium is still starting ends it at once; on Linux and macOS the starting
  browser is stopped too.
- **Chrome extension**: a relative `open_url` (a site map path) resolves on the page the run is on instead of being
  refused as malformed, and never leaves that page's origin.

## [0.1.4] - 2026-10-22

### Added

- **Chrome extension**: dragging one element onto another, setting a read-only date field through its calendar,
  committing an autocomplete suggestion, and copying an element's text into a field, each as one move.
- **Chrome extension**: optional accuracy switches, off by default and set at build time with `DREX_ACC`:
  - `stepCaps`: a step asked for what its kind can't do is split into steps that can.
  - `stateReceipt`: a click records what it changed on the clicked control.
  - `factStore`: the values each read sees are kept across steps.
  - `settingReadback`: a setting step ends only when the page shows the values its moves set.
  - `deadUrls`: a guessed address that shows a not-found page is left.
  - `longSelects`: a select with more than 30 options keeps them.
  - `navMap`: the planner gets the site's own navigation links, hidden menu items included.
  - `frames`: the controls of same-site iframes are listed with the page's.
- **Chrome extension**: changes that the site's own requests confirm are not answered with an error status, and the
  end of a run scrolls the facts its answer cites into view (`confirmedChanges` and `revealEvidence`, on by default).

### Fixed

- **Chrome extension**: a click lands on the visible part of a control inside a scrollable panel.
- **Chrome extension**: a native multiple select is set and checked as the whole requested set.
- **Chrome extension**: a single select is checked after it is set, with one recovery when the choice didn't hold.
- **Chrome extension**: typing a date or time at the cursor sets the whole input.
- **Chrome extension**: scrolling targets the right box, key chords edit text, icons are named from their classes, and
  rich-text editors are treated as text boxes.
- **Chrome extension**: loops up to nine moves long are noticed, and a batch over a list stops after three empty pages.
- **Chrome extension**: a new working tab opens blank before it goes to its address, so tools that record the
  browser's traffic see its first page.

## [0.1.3] - 2026-10-21

### Fixed

- **Chrome extension**: read-only fields, such as a date picker's input, are clicked instead of typed into.
- **Chrome extension**: date and time inputs take the typed value whole; typed key by key, a time landed in one segment.
- **Chrome extension**: a custom slider's value is read from its handle, the element it names or the label beside it.
- **Chrome extension**: a multiple select keeps earlier choices, and a form text area is described as one.
- **Chrome extension**: phone, mail and text-message links are not offered as moves; they open another app.
- **Chrome extension**: a column or field named after an act ("Purchase Date", "Order Total") no longer asks for
  approval; the act itself still does.
- **Chrome extension**: a task that needs every match in a list reads the whole list (up to 12 pages) instead of
  stopping after two pages without a match.
- **Chrome extension**: recorded values and confirmed changes keep the success status in the final answer when the
  run's own check was unsure.

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
