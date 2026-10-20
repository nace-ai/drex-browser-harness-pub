# nace-browser

`nace-browser` runs the Drex browser agent in a local Chromium, for coding agents: a CLI and an MCP server over the
same run. Drex Max makes the clicks and keystrokes; an LLM (Claude Haiku 5.5 by default) plans, reads and checks.

It is not published to npm. Build it from a checkout of the repository:

```bash
git clone https://github.com/nace-ai/drex-browser-harness-pub.git drex-browser && cd drex-browser
npm ci && npm run build:release
node runner/bin/nace-browser.mjs install
npm link -w runner            # optional: `nace-browser` on your PATH
# with DREX_API_KEY and ANTHROPIC_API_KEY set in your shell profile:
nace-browser run "What is the top story?" --url https://news.ycombinator.com --json
claude mcp add --scope user nace-browser -- node "$PWD/runner/bin/nace-browser.mjs" mcp
```

- `run --json` and the MCP tool `browser_task` return the same result shape.
- A best-effort guard denies recognized risky clicks; `--allow-risky` disables it on the CLI. Unrecognized clicks
  and Enter can still send, pay, delete or order. Use only tasks and accounts where you authorize those effects.
- Sign-ins and CAPTCHAs end the run; `nace-browser login URL` opens a window to sign in once per profile.
- Profiles live in `~/.nace/browser/profiles/<name>`, one run at a time each; `--temp-profile` uses a throwaway one.
- Keys come only from the environment and are never written to disk. Keep them out of MCP config files.

Full documentation, with setups for Claude Code, Codex, Cursor, Hermes and Pi:
https://github.com/nace-ai/drex-browser-harness-pub/blob/main/docs/runner.md
