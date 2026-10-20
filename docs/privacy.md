# Privacy

Drex Browser is made by Nace AI ("Nace"). It carries out browser tasks that you, or a coding agent you set up, describe
in plain words. This page explains what data it handles, where that data goes, and what you control. It covers the
Chrome extension and the local runner (`nace-browser`) with its MCP server.

## When data is sent

Nothing is sent anywhere until a task starts: when you press Run in the side panel, run `nace-browser`, or a coding
agent you connected calls a browser tool. Between tasks, the extension and the runner send nothing.

There is no telemetry, no analytics and no advertising code in the extension or the runner. They make network
requests only to Drex and to the LLM provider whose key you gave, and, in the extension's pairing mode, to the local
MCP server on `127.0.0.1`.

## What is sent, and to whom

### To Drex (`console.nace.ai`)

Drex Max picks each move. For each move it receives:

- screenshots of the page the agent is working on: as shown, and with the candidate controls outlined and numbered;
- the page's controls (buttons, links, fields) from its accessibility tree, with their labels and nearby text;
- the task or the current step, and the moves made so far;
- site tips for the page, and, for steps that work through a list, the list's rows.

The request is made with your Drex API key, and usage is billed to that account. How Nace keeps and uses this data is
governed by the [Drex privacy policy](https://console.nace.ai/privacy) and the terms of your Drex account.

### To your LLM provider

The LLM plans the task, reads pages and checks the result. It receives the task, today's date, page text, screenshots,
the page's controls, and the agent's notes. In the extension, it also receives the **titles and URLs of your open
tabs**, so the plan can use pages you already have open.

The provider is the one whose key you gave: Anthropic by default (Claude Haiku 5.5), or OpenAI, Google, OpenRouter or
Fireworks. Only that provider is called, with your key, and its own terms govern what it receives: for Anthropic, its
[Commercial Terms](https://www.anthropic.com/legal/commercial-terms) and [privacy policy](https://www.anthropic.com/legal/privacy).

### What pages can contain

The pages the agent works on can hold whatever the task touches: email, documents, account or order details, and
personal or payment information shown on screen. All of it can be in the screenshots and page text sent above. Use
Drex Browser only on pages whose content you are willing to send to Drex and your LLM provider.

### To a local coding agent (extension, only when turned on)

With **Let coding agents use Drex** on and an agent paired, the extension sends that agent's local MCP server the run
summaries, the list of your open tabs, and the screenshots and page text the agent asks for. This stays on your
computer; what the agent does with it is governed by that agent and its own model provider.

## What is stored on your device

- **Extension:** your settings, your API keys and the pairing code, in the extension's local storage on that browser
  profile, not synced. The run log is saved only when you click **Download run log**.
- **Local runner:** browser profiles (including the sign-ins you make in them) under `~/.nace/browser/profiles`, and run
  logs, screenshots and results under `~/.nace/browser/runs`. Keys from your environment are not saved.

## Your controls

- **Stop** a run at any time, or close Chrome's "started debugging this browser" bar.
- Keep **Ask before risky actions** on, so recognized payments, sends, deletions and orders wait for you.
- Turn **Let coding agents use Drex** off, or make a new pairing code, to cut off coding agents.
- Delete a runner profile folder to remove its sign-ins; delete `~/.nace/browser/runs` to remove run outputs.
- Revoke your API keys at [console.nace.ai](https://console.nace.ai/dashboard/api-keys) and with your LLM provider.
- Remove the extension from `chrome://extensions` to delete its settings and keys.

## Contact

Questions about how Drex handles data: the contact address in the [Drex privacy policy](https://console.nace.ai/privacy).
Security issues: report them privately as [SECURITY.md](../SECURITY.md) describes.
