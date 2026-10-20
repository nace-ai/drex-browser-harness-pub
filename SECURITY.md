# Security

Please report a vulnerability privately to **security@nace.ai**. **Please don't open a public GitHub issue, pull
request or discussion for a vulnerability**: that makes it public before it is fixed. Include what you found, how to
reproduce it, and which part and version it affects (the extension's version from `chrome://extensions`, or
`nace-browser --version`). We will acknowledge your report and keep you informed until it is fixed.

Do not include real credentials, cookies or private page content in a report. If a run log or screenshot shows the
problem, remove anything personal from it first, or describe it instead.

## Scope

In scope:

- **The Chrome extension**: anything that lets a web page, another extension or a local program control the agent,
  read data the user did not share, or make the agent take an action the user did not approve (for example, bypassing
  the approval card for a risky click).
- **The MCP server and the local runner** (`nace-browser`): reading pages or profiles outside a run the agent asked
  for, raising limits an agent should not be able to raise, escaping a profile, leaking keys or tokens into logs,
  artifacts or builds, and the pairing between the extension and a local coding agent.
- **Keys**: anything that exposes a Drex API key or an LLM key, or lets one account act as another.
- **Release builds**: a build or package that ships keys, local paths or code that was not reviewed.

Out of scope here:

- The Drex API itself (`console.nace.ai`): report it to the same address, and we will route it.
- Prompt injection that only makes a run fail or return a wrong answer. Injection that leads to a risky action without
  approval, or to data leaving the run, is in scope.
- The risky-click guard missing a control whose label does not say what it does. This is a known limit of a
  best-effort guard (see the README's Safety section); a report that shows a general bypass is welcome.

## Supported versions

Security fixes go to the latest release on the `main` branch. Nothing is published to npm or the Chrome Web Store, so
update by pulling `main` and rebuilding.
