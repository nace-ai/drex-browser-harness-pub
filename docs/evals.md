# Evals

How we measure Drex Browser's accuracy and cost. The eval harness runs privately, because it uses the maintainers'
credentials and infrastructure; this page describes what it measures so the numbers can be read and questioned.

## Benchmarks

| Benchmark | What it tests | How a task is graded |
| --- | --- | --- |
| [WebArena-Verified](https://github.com/ServiceNow/webarena-verified), shopping | Multi-step tasks on a self-hosted copy of an online shop: searching, filtering, comparing, reading order history | The benchmark's own evaluator, from the agent's answer and the shop's network traffic |
| [MiniWoB++](https://github.com/Farama-Foundation/miniwob-plusplus) | Short tasks on small synthetic pages: buttons, checkboxes, lists, menus, tabs, forms and tables | The page's own reward |
| Local test pages | Forms, menus, a mailbox, a checkout and a flight search, kept in this repository's end-to-end tests | Each page's own checker |

Each attempt loads a build of the extension in Playwright's Chromium in a 1280×800 window, gives it the benchmark's own
task text, and grades it with the benchmark's own grader. Moves come from Drex Max, and planning and reading from
Claude Haiku 5.5, with the default run limits. On WebArena, every attempt gets a freshly reset copy of the shop, signed
in as the benchmark's test customer. A task counts as solved only when the grader says so, and every attempt counts,
including ones that hit a limit or fail.

On WebArena-Verified we use two task sets: a development set of 20 attempts that changes are tuned against, and a
held-out set (HOLDOUT-1, 60 attempts) that is not used for tuning.

**Cost** is what the tokens each run used would cost at the providers' API list prices: Drex Max input tokens plus LLM
input and output tokens. For the coding agents below, it is the API-equivalent cost of the same tokens, not a
subscription price. It excludes the cost of running the browser.

## Latest results

Measured in October 2026:

| Benchmark | Solved | Cost per attempt |
| --- | --- | --- |
| WebArena-Verified shopping, development set | 15/20 (75%) | about $0.0047 |
| WebArena-Verified shopping, held-out set (HOLDOUT-1) | 32/60 (53%) | |
| MiniWoB++ | 59/60 | |

For comparison, two general coding agents, on the same WebArena-Verified development set:

| Agent | WebArena-Verified (development) | Cost per attempt |
| --- | --- | --- |
| Drex Browser (Drex Max + Claude Haiku 5.5) | 75% | about $0.0047 |
| Claude Code with Claude Haiku 5.5 | 85% | about $0.0084 |
| Codex with gpt-6-luna | 70% | about $0.0054 |

How to read these numbers:

- **They are small samples.** Rerunning the same 20 development attempts moves the score by about ±2 tasks, so a
  difference of 10 points on that set is within noise.
- **The development set is tuned against**, so the held-out score is the better guide to a task you bring yourself.
- Drex Browser is cheaper per attempt than both coding agents here, and less accurate than Claude Code on these
  multi-step tasks.

We will publish each release's numbers here, with the date and the version measured.

## Running your own checks

The repository's tests include end-to-end checks against local test pages; they need your own keys and skip themselves
without them (see [CONTRIBUTING.md](../CONTRIBUTING.md)). If you find a site or task where the agent does badly, open an
issue with the task and the outcome: these become eval cases.
