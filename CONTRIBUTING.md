# Contributing

Thanks for helping make Drex Browser better.

## Build from source

You need Node 22.18 or later and npm.

```bash
git clone https://github.com/nace-ai/drex-browser-harness-pub.git drex-browser && cd drex-browser
npm ci
npm run build    # runs the checks, then builds the extension into dist/
npm test
```

To try the extension, open `chrome://extensions`, turn on Developer mode, choose **Load unpacked** and pick `dist/`.

Your own keys go in your environment or in the extension's settings, never in the repository. A local `.env` is
ignored by git; release builds refuse to include keys or local paths.

## Checks

| Command | What it checks |
| --- | --- |
| `npm run check` | Lint (no warnings allowed), TypeScript types and formatting |
| `npm run build` | The checks, then the build |
| `npm run build:release` | The release build, which refuses keys and local paths, and its copy for the runner package |
| `npm test` | The tests. Tests that need a real browser or real keys skip themselves when those are missing |

The browser tests need Playwright's Chromium (`node runner/bin/nace-browser.mjs install`) and a release build. CI runs
the same commands on every pull request, on GitHub-hosted runners, with no secrets, and with
`NACE_REQUIRE_BROWSER_TESTS=1` so the browser tests fail instead of skipping.

## Accuracy and safety changes

Changes to how the agent plans, picks moves, types, or decides what is risky can make it better on one site and worse on
another. The maintainers run them through the benchmark evals (see [docs/evals.md](docs/evals.md)) before merging, and
will share the before and after numbers on the pull request. Describe the sites and tasks you tried in the pull request.

A change that weakens a safety default (approvals, the risky-action list, refusing to type credentials, run limits) needs
a clear reason and a maintainer's explicit agreement.

## Pull requests

- One change per pull request, with tests for new behavior and for the bug a fix closes.
- Keep new code in the style of the code around it. Comments explain why, not what.
- No new runtime dependencies without a strong reason, and only with a permissive license.
- Never commit keys, tokens, `.env` files, run logs, HAR files or screenshots of real accounts.
- Update the docs and `CHANGELOG.md` (under Unreleased) when behavior a user can see changes.
- By contributing you agree that your contribution is licensed under the MIT License (see [LICENSE](LICENSE)).

Report security issues privately: see [SECURITY.md](SECURITY.md).
