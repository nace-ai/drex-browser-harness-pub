# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).
Each entry names the part it changes: the Chrome extension or the local runner (`nace-browser`).

## [Unreleased]

### Changed

- README: a hero image, a nav line, a demo of a real run, and Benchmarks and How it works sections. Benchmarks compares pass rate and cost
  per task with Claude Code and Codex on WebArena-Verified, Online-Mind2Web and MiniWoB++. The images come in light and
  dark and are rendered from `docs/assets/src/benchmarks.json` by `scripts/readme-assets.mjs`.
- `docs/evals.md`: the results of 20 October 2026, with Online-Mind2Web and the coding agents on every set they ran. The
  30-task WebArena set (HOLDOUT-1) is no longer described as unused for tuning: its failures were studied during
  development.

## [0.1.0] - 2026-10-20

The first public release of the source. Nothing is published to npm or the Chrome Web Store: build the runner and the
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
- The agent: Drex Max picks each move; Claude Haiku 5.5 (by default) plans, reads and checks. OpenAI, Google Gemini,
  OpenRouter and Fireworks models can be chosen instead.
- A Claude Code plugin (`plugins/nace-browser`) with the MCP server and a skill about when to use the browser.
- Docs for the runner, the MCP tools, keys, the extension's settings, privacy and evals; security and contribution
  policies; issue and pull request templates; a CI workflow that builds, checks and tests every pull request.
- Synthetic end-to-end test pages (`e2e/site/`) and unit and browser tests.

### Known limitations

- Accuracy: 75% on WebArena-Verified shopping development tasks, 53% on held-out ones ([docs/evals.md](docs/evals.md)).
- Risky-click detection reads control names against a list of English words.
- Cloud runs are not available.
