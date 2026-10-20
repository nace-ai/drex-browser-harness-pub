# Chrome Web Store listing: maintainer notes

> [!NOTE]
> **For maintainers, not for users.** Draft text for a future Chrome Web Store submission. The extension is not on
> the Chrome Web Store; to use it, build it and load it unpacked as the [README](../README.md#the-chrome-extension)
> describes. Items marked **[TBD]** are decided at submission time.

## Basics

| Field | Value |
| --- | --- |
| Name | Drex Browser Agent |
| Short description (132 characters at most) | Describe a web task in plain words. Drex clicks and types in your own tabs, asks before risky actions, and shows you the result. |
| Category | Productivity |
| Language | English |
| Homepage URL | **[TBD]** this repository once public, or a page on nace.ai |
| Support URL | **[TBD]** this repository's Issues once public, or a Nace support address |
| Privacy policy URL | **[TBD]** the published version of [privacy.md](privacy.md) on `console.nace.ai` |

## Full description

> Drex Browser Agent does web tasks for you in your own Chrome. Describe what you want in plain words, such as "fill in
> this registration form with my details" or "find the cheapest 1 TB SSD on this shop", and watch it work in a side
> panel: the plan, each step, a live view of the page and the running cost.
>
> How it works: Drex Max, a fast decision model, picks each click and keystroke from the page's controls. An LLM you
> choose (Anthropic, OpenAI, Google Gemini, Fireworks or OpenRouter, with your own key) plans the task, reads pages and
> checks the result.
>
> You stay in control:
> • It asks before risky actions such as paying, sending, deleting or placing an order: Stop, Allow once, or Allow for
>   this task.
> • It never types passwords or payment details, and never solves CAPTCHAs. It hands the screen to you instead.
> • It works in its own tab group, and Chrome shows its "started debugging" bar the whole time. Close the bar, or press
>   Stop, to end a run.
> • Every run has a time, call and cost limit.
>
> Nothing is sent until you start a task. During a task, screenshots and page content go to Drex (Nace) and to the LLM
> provider you chose. No telemetry, no ads, no data sales. See the privacy policy for details.
>
> Needs a Drex API key (create one at console.nace.ai; new accounts get free credit) and a key for one supported LLM
> provider.
>
> Optional: let a coding agent on your computer, such as Claude Code, Codex or Cursor, give the extension tasks through a
> local, paired MCP server.

## Screenshot captions (1280×800, 1 to 5)

Make these from the repository's local test site, never from a real account.

1. Describe a task in plain words; Drex plans the steps.
2. Watch every move in the live view, with the running cost.
3. Risky actions wait for your approval.
4. Sign-ins and CAPTCHAs are handed to you.
5. Connect a coding agent with a pairing code.

Also needed: a small promo tile (440×280). Optional: a marquee (1400×560).

## Permission justifications

| Permission | Justification |
| --- | --- |
| `debugger` | The extension carries out tasks the user types, in the user's own tabs. It uses the Chrome DevTools Protocol to read the page's accessible controls and a screenshot, and to send real mouse and keyboard input to the tab it works in. It attaches only to a tab during a task the user started, or one a paired local coding agent requested, and Chrome shows its "started debugging" bar the whole time. Closing that bar stops the agent. |
| `tabs` | Opens the agent's own tabs, follows tabs its clicks open, and lists the open tabs (title and URL) so the task planner can use pages the user already has open. |
| `tabGroups` | Puts the tabs the agent opens in a "Drex" group so the user can see and close them. |
| `sidePanel` | The extension's interface (task box, plan, live view, approvals, settings) is a side panel. |
| `storage` | Stores the user's settings and API keys locally in this browser profile (`chrome.storage.local`). |
| `notifications` | Notifies the user when the agent waits for an approval or a hand-over (for example, before a payment click) while the panel is closed. |
| `alarms` | Restarts the link to the user's local coding-agent server once a minute, only while the user has turned that feature on. |
| Host `https://console.nace.ai/*` | Drex Max, the decision model that picks each move. |
| Hosts `https://api.anthropic.com/*`, `https://api.openai.com/*`, `https://api.fireworks.ai/*`, `https://generativelanguage.googleapis.com/*`, `https://openrouter.ai/*` | The LLM provider the user picks, with their own key, plans tasks and reads pages. Only the provider whose key the user entered is called. |

**Remote code:** None. All scripts are bundled in the package. Scripts the agent runs in a page go through the Chrome
DevTools Protocol and are fixed strings bundled in the extension.

## Notes for the reviewer

- To test: install, open the side panel (Alt+Shift+D), enter a Drex API key and an LLM key **[TBD: test keys supplied
  through the dashboard's reviewer notes, never in this file]**, and run "Find today's top 5 Hacker News stories and list
  them".
- The service worker keeps itself awake with a light call every 20 seconds **[confirm when it runs]**, and while "Let coding agents use Drex" is on
  a one-minute alarm restarts the link to the local coding-agent server. The alarm does not run with that feature off.
- A storage key used by the end-to-end tests to supply a fixed plan is read in the production build. It has no effect
  unless set by a test harness. **[Remove before submission, or explain here.]**

## Privacy practices (draft answers)

**Single purpose:** Carry out web tasks that the user describes in plain words, in the user's own browser tabs.

**Data collected** (declare each; content is processed only during a task the user or their paired coding agent starts):

| Category | Why |
| --- | --- |
| Website content | Text, controls and screenshots of the pages the agent works on, sent to Drex Max and the user's LLM provider to choose and check each move. |
| Web history | Titles and URLs of open tabs, sent to the user's LLM provider so the plan can use pages already open. |
| Personal communications | Email or message text, when a task covers a mailbox. |
| Personally identifiable information | It can appear on pages the agent screenshots. |
| Financial and payment information | It can appear on pages the agent screenshots. The agent never types payment details. |
| Authentication information | API keys the user enters, stored locally and sent only to their own provider. |

**Certifications:**

- I do not sell or transfer user data to third parties, outside of the approved use cases.
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose.
- I do not use or transfer user data to determine creditworthiness or for lending purposes.

The Limited Use statement must be checked against the Drex privacy policy's retention terms before it is certified.
