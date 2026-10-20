# Chrome extension settings

The extension is built from this repository and loaded unpacked ([README](../README.md#the-chrome-extension)). This
page describes the settings of version 0.1.0.

Open the side panel with **Alt+Shift+D** (or the toolbar icon), then the gear icon. Settings are saved in this browser
profile only (`chrome.storage.local`); nothing is synced to your Google account.

## Keys

| Setting | What it does |
| --- | --- |
| **Drex API key** | Your Drex API key, used for Drex Max, which picks each move. Create one under **API Keys** at [console.nace.ai](https://console.nace.ai/dashboard/api-keys). New accounts get free credit. See [auth.md](auth.md). |
| **LLM API key** | The key for the LLM that plans the task, reads pages and checks the result. Anthropic, OpenAI, Google Gemini, Fireworks or OpenRouter. Each key is sent only to its own provider. |
| **Check keys** | Tests each key with its provider and says what is wrong if one fails. |

## Model

| Setting | Default | What it does |
| --- | --- | --- |
| **Model for planning and help** | Claude Haiku 5.5 | The model that plans, reads and checks. Paste a key from any supported provider and its models show up in the list. Larger models plan better on unusual tasks and cost more; the run's cost limit scales with the model's price. |
| **Plan with the LLM first** | On | Writes a step-by-step plan before the first move, and replans when a step fails. Off: no plan; Drex starts on your task as you wrote it and makes every move, the LLM only writes text to type, and it never replans. |

## Running

| Setting | Default | What it does |
| --- | --- | --- |
| **Work in a background tab** | On | Keep browsing while the agent works in its own tab; the panel's live view shows its screen. The agent's tabs go in a "Drex" tab group. |
| **Show Drex's cursor** | On | A "Drex" cursor glides to each click in the agent's tab, and the live view marks the target. |
| **Ask before risky actions** | On | Before a click recognized as pay, send, delete, publish or place an order, a click at a bare screen point, or a bulk action over list items, the panel shows an approval card: **Stop**, **Allow once** or **Allow for this task**. Turned off, your own runs make these clicks without asking (a coding agent's runs still stop); sign-ins and CAPTCHAs still wait for you. Keep it on unless you are watching the run. |
| **Notify me when Drex needs me** | On | A system notification when the agent waits for your approval or hands the screen to you (for example, to sign in) while the panel is closed. |

## Run limits

Every run stops when it reaches one of these limits, and reports what it found so far.

| Limit | Default |
| --- | --- |
| Time | 600 seconds |
| LLM calls | 20 |
| Model cost | $0.04 with Claude Haiku 5.5, scaled to the price of the model you pick |

The panel shows the run's cost as it goes. **Stop** ends a run at any time; so does closing Chrome's
"started debugging this browser" bar.

## Coding agents

| Setting | Default | What it does |
| --- | --- | --- |
| **Let coding agents use Drex** | Off | Lets a coding agent on this computer (Claude Code, Codex, Cursor and others) run tasks in this browser through a local MCP server. Turning it on shows a **pairing code** and the setup for each agent. The extension talks only to a server on `127.0.0.1` that proves it knows the pairing code. |
| **New code** | | Replaces the pairing code. Agents set up with the old code stop working until you update their setup. |

A run started by a coding agent cannot wait for an approval card, so its risky steps always ask: a risky step ends the
run and hands control back to the agent and to you, even with **Ask before risky actions** off (that setting applies to
your own runs only).

A paired agent can list (`drex_tabs`), read (`drex_read_page`) and screenshot (`drex_screenshot`) only the tabs its own
runs opened or worked in. Your other tabs, such as your email, stay out of its reach. Pair only agents you trust.

For most coding agents, the [local runner](runner.md) is the simpler and safer choice: it needs no extension and uses its own
browser profile.

## Other

| Control | What it does |
| --- | --- |
| **Download run log** | Saves the last run's full log (plan, moves, page text the agent read, costs) as a JSON file. Nothing is uploaded. Remove personal data before attaching it to an issue. |
| **Keyboard shortcut** | Alt+Shift+D opens the panel. Change it at `chrome://extensions/shortcuts`. |
