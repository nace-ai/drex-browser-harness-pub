# Evals

How we measure Drex Browser Use's accuracy and cost. The eval harness runs privately, because it uses the maintainers'
credentials and infrastructure; this page describes what it measures so the numbers can be read and questioned.

## Benchmarks

| Benchmark | What it tests | How a task is graded |
| --- | --- | --- |
| [WebArena-Verified](https://github.com/ServiceNow/webarena-verified) v1.2.3, shopping | Multi-step tasks on a self-hosted copy of an online shop: searching, filtering, comparing, reading order history, writing reviews | The benchmark's own evaluator, from the agent's answer and the shop's network traffic |
| [MiniWoB++](https://github.com/Farama-Foundation/miniwob-plusplus) | Short tasks on small synthetic pages: buttons, checkboxes, lists, menus, tabs, forms and tables | The page's own reward |

Each attempt loads a build of the extension in Playwright's Chromium in a 1280×800 window, gives it the benchmark's own
task text, and grades it with the benchmark's own grader. Drex Max takes the actions, and Claude Haiku 5.5 helps with
planning, reading and checking, with the default run limits. On WebArena, every attempt gets a freshly reset copy of
the shop, signed in as the benchmark's test customer. A task counts as solved only when the grader says so, and every attempt
counts, including ones that hit a limit or fail.

On WebArena-Verified, the results below are on the development set: 10 tasks that changes are tuned against. Their failures have been
studied while developing the agent, so the set likely overstates how it does on a task you bring yourself. Further
task sets are kept back for release numbers.

**Cost** is what the tokens each run used would cost at the providers' API list prices: Drex Max input tokens plus LLM
input and output tokens. For the coding agents below, it is the API-equivalent cost of the same tokens, not a
subscription price (Claude Code's own cost line is wrong for Haiku 5.5, so it is recomputed from the tokens). It
excludes the cost of running the browser.

## Latest results

A try is one attempt at one task; the pass rate counts every try, and cost and time are per try. Drex Browser Use 0.1.0
was measured on 20 October 2026, with more tries per task than the coding agents had. The coding agents, Claude Code
and Codex, were given the same task text, a Chromium window of their own and their usual shell and file tools, and
measured on 19 and 20 October 2026 with the same tasks, graders and machine.

| Benchmark | Agent | Tasks × tries | Pass rate | $ per task | s per task |
| --- | --- | ---: | ---: | ---: | ---: |
| WebArena-Verified, development set (10 tasks) | **Drex Browser Use** | 10 × 4 | 73% (29 of 40) | 0.0041 | 36 |
| | Claude Code with Claude Haiku 5.5 | 10 × 2 | 85% (17 of 20) | 0.0084 | 89 |
| | Codex with gpt-6-luna | 10 × 2 | 70% (14 of 20) | 0.0054 | 69 |
| | Claude Code with Claude Sonnet 5.5 | 10 × 1 | 90% (9 of 10) | 0.074 | 55 |
| | Codex with gpt-6.1-sol | 10 × 1 | 80% (8 of 10) | 0.073–0.103 | 59 |
| MiniWoB++ (20 tasks) | **Drex Browser Use** | 20 × 2 | 98% (39 of 40) | 0.0013 | 12 |
| | Claude Code with Claude Haiku 5.5 | 20 × 2 | 90% (36 of 40) | 0.0038 | |
| | Codex with gpt-6-luna | 20 × 2 | 80% (32 of 40) | 0.0025 | |
| | Claude Code with Claude Sonnet 5.5 | 20 × 2 | 88% (35 of 40) | 0.024 | |
| | Codex with gpt-6.1-sol | 20 × 2 | 98% (39 of 40) | 0.028 | |

How to read these numbers:

- **They are small samples.** Rerunning the same development tasks moves the score by about ±2 tasks in 20, so a
  difference of 10 points on that set is within noise.
- **Drex Browser Use is the cheapest agent in every row.** 1,000 tasks like the development set cost $4.10 in model
  calls, against $5.40 for Codex with gpt-6-luna, $8.40 for Claude Code with Haiku, $74 for Claude Code with Sonnet and
  $73 to $103 for Codex with gpt-6.1-sol. On MiniWoB++, $1.30 against $2.50 for Codex with gpt-6-luna, $3.80 for
  Claude Code with Haiku, $24 for Claude Code with Sonnet and $28 for Codex with gpt-6.1-sol.
- **Accuracy:** on MiniWoB++ it ties Codex with gpt-6.1-sol (98%) and leads Claude Code with Haiku or Sonnet and
  Codex with gpt-6-luna. On the WebArena development set it sits between Codex with gpt-6-luna and Claude Code with
  Haiku.

The README's benchmark image and table come from [`docs/assets/src/benchmarks.json`](assets/src/benchmarks.json).
After changing it, render the images again with `node scripts/readme-assets.mjs`.

We will publish each release's numbers here, with the date and the version measured.

## Running your own checks

The repository's tests include end-to-end checks against local test pages; they need your own keys and skip themselves
without them (see [CONTRIBUTING.md](../CONTRIBUTING.md)). If you find a site or task where the agent does badly, open an
issue with the task and the outcome: these become eval cases.
