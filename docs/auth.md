# Keys

Drex Browser calls two services on your behalf, each with its own API key:

| Key | Where to get it | Used for |
| --- | --- | --- |
| Drex API key (`nace_sk_…`) | [console.nace.ai](https://console.nace.ai/dashboard/api-keys), under **API Keys**. New accounts get free credit; usage is billed to the account. | Drex Max, which picks each click and keystroke |
| Anthropic API key (`sk-ant-…`) | The [Claude Console](https://console.anthropic.com/) | Claude Haiku 5.5, the default LLM that plans, reads and checks |

Other LLM providers work with their own key (OpenAI, Google Gemini, OpenRouter, Fireworks), but accuracy was measured
with Claude Haiku 5.5. Signing in with your Drex account instead of a key is not available.

## Local runner and MCP server

The runner reads keys only from the environment of the process that starts it: `DREX_API_KEY`, and `ANTHROPIC_API_KEY`
for the default model (`OPENAI_API_KEY`, `GOOGLE_API_KEY` or `GEMINI_API_KEY`, `OPENROUTER_API_KEY` or
`FIREWORKS_API_KEY` for others). It hands them to the browser for each run only, and never writes them to the browser
profile, run artifacts, logs or the build.

The recommended setup is to set the variables in your shell profile and let your agent pass them to the MCP server:

```bash
# ~/.zshrc, ~/.bashrc or similar
export DREX_API_KEY=nace_sk_...
export ANTHROPIC_API_KEY=sk-ant-...
```

Each agent forwards variables to MCP servers in its own way: Claude Code passes its whole environment, Codex passes the
names listed in `env_vars`, Cursor reads `${env:NAME}` and Hermes reads `${NAME}`. The snippets are in
[runner.md](runner.md#agents).

> [!WARNING]
> Never paste a key into an agent's MCP config file, a project file or a command line. Config files are plain text that
> is easy to commit, sync or share, and command lines end up in your shell history. Anyone with your Drex key can spend
> your Drex credit.

To keep keys out of plain-text dotfiles, store them in your OS keychain and read them in your shell profile. On macOS:

```bash
security add-generic-password -a "$USER" -s drex -w        # prompts for the Drex key, once
security add-generic-password -a "$USER" -s anthropic -w   # prompts for the Anthropic key, once
# then, in your shell profile:
export DREX_API_KEY="$(security find-generic-password -a "$USER" -s drex -w)"
export ANTHROPIC_API_KEY="$(security find-generic-password -a "$USER" -s anthropic -w)"
```

On Linux with the Secret Service (for example GNOME Keyring), `secret-tool store --label=drex service drex` and
`secret-tool lookup service drex` do the same.

## Chrome extension

The extension stores the keys you enter in its settings in the browser's local extension storage
(`chrome.storage.local`), on that browser profile only, not synced to your Google account. It sends each key only to
its own provider.

## Revoking a key

Revoke a key you no longer use, or one that may have leaked: the Drex key under **API Keys** at
[console.nace.ai](https://console.nace.ai/dashboard/api-keys), and the Anthropic key in the Claude Console.
