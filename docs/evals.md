# Evals

How we measure Drex Browser's accuracy and cost. The eval harness runs privately, because it uses the maintainers'
credentials and infrastructure; this page describes what it measures so the numbers can be read and questioned.

## Benchmarks

| Benchmark | What it tests | How a task is graded |
| --- | --- | --- |
| [WebArena-Verified](https://github.com/ServiceNow/webarena-verified) v1.2.3, shopping | Multi-step tasks on a self-hosted copy of an online shop: searching, filtering, comparing, reading order history, writing reviews | The benchmark's own evaluator, from the agent's answer and the shop's network traffic |
| [Online-Mind2Web](https://huggingface.co/datasets/osunlp/Online-Mind2Web) | Real tasks on live websites: travel, shopping, government, housing, jobs and more, at three levels of difficulty | [WebJudge](https://arxiv.org/abs/2504.01382) with Claude Sonnet 5.5, from the task, the agent's screenshots and its answer |
| [MiniWoB++](https://github.com/Farama-Foundation/miniwob-plusplus) | Short tasks on small synthetic pages: buttons, checkboxes, lists, menus, tabs, forms and tables | The page's own reward |
| Local test pages | Forms, menus, a mailbox, a checkout and a flight search, kept in this repository's end-to-end tests | Each page's own checker |

Each attempt loads a build of the extension in Playwright's Chromium in a 1280×800 window, gives it the benchmark's own
task text, and grades it with the benchmark's own grader. Moves come from Drex Max, and planning and reading from
Claude Haiku 5.5, with the default run limits. On WebArena, every attempt gets a freshly reset copy of the shop, signed
in as the benchmark's test customer. A task counts as solved only when the grader says so, and every attempt counts,
including ones that hit a limit or fail.

On WebArena-Verified we use two task sets: a development set of 10 tasks that changes are tuned against, and a second
set of 30 tasks (HOLDOUT-1) that every change is also checked on. Failures on both sets have been studied while
developing the agent, so both likely overstate how it does on a task you bring yourself. Further held-out sets are
kept back and will be measured once, on a frozen build, for each release.

On Online-Mind2Web we use 50 of the dataset's 300 tasks, on websites that load for an automated browser (no bot wall or
region block when we screened them), across its three levels. Live sites change and sometimes refuse automated
browsers; an attempt a site blocked still counts as a failure.

**Cost** is what the tokens each run used would cost at the providers' API list prices: Drex Max input tokens plus LLM
input and output tokens. For the coding agents below, it is the API-equivalent cost of the same tokens, not a
subscription price (Claude Code's own cost line is wrong for Haiku 5.5, so it is recomputed from the tokens). It
excludes the cost of running the browser and, on Online-Mind2Web, the judge.

## Latest results

Drex Browser 0.1.0, measured on 20 October 2026. The coding agents, Claude Code and Codex, were given the same task
text, a Chromium window of their own and their usual shell and file tools, and measured on 19 and 20 October 2026 with
the same tasks, graders and machine.

| Benchmark | Agent | Solved | Pass rate | $ per attempt | s per attempt |
| --- | --- | ---: | ---: | ---: | ---: |
| WebArena-Verified, development set (10 tasks) | **Drex Browser** | 29/40 | 73% | 0.0041 | 36 |
| | Claude Code with Claude Haiku 5.5 | 17/20 | 85% | 0.0084 | 89 |
| | Codex with gpt-6-luna | 14/20 | 70% | 0.0054 | 69 |
| | Claude Code with Claude Sonnet 5.5 | 9/10 | 90% | 0.074 | 55 |
| | Codex with gpt-6.1-sol | 8/10 | 80% | 0.073–0.103 | 59 |
| WebArena-Verified, HOLDOUT-1 (30 tasks) | **Drex Browser** | 27/60 | 45% | 0.0063 | 54 |
| | Claude Code with Claude Haiku 5.5 | 39/60 | 65% | 0.0074 | 85 |
| Online-Mind2Web (50 tasks) | **Drex Browser** | 15/50 | 30% | 0.0099 | 86 |
| | Claude Code with Claude Haiku 5.5 (two runs) | 67/100 | 67% | 0.018 | 168 |
| MiniWoB++ (20 tasks) | **Drex Browser** | 39/40 | 98% | 0.0013 | 12 |
| | Claude Code with Claude Haiku 5.5 | 36/40 | 90% | 0.0038 | |
| | Codex with gpt-6-luna | 32/40 | 80% | 0.0025 | |
| | Claude Code with Claude Sonnet 5.5 | 10/10 | 100% | | |
| | Codex with gpt-6.1-sol | 10/10 | 100% | | |
| Local test pages (13 tasks) | **Drex Browser** | 24/26 | 92% | 0.0035 | 24 |

How to read these numbers:

- **They are small samples.** Rerunning the same development tasks moves the score by about ±2 tasks in 20, so a
  difference of 10 points on that set is within noise. A run of the same agent one commit earlier scored 32/60 on
  HOLDOUT-1, against 27/60 here.
- **Drex Browser is the cheapest agent in every row.** It leads on short tasks (MiniWoB++) and sits between Codex with
  gpt-6-luna and Claude Code with Haiku on the development set. On longer tasks, HOLDOUT-1 and the live sites of
  Online-Mind2Web, it trails Claude Code with Haiku by 20 points or more.
- **WebJudge agrees with human judges about 86% of the time**, according to its authors: good enough for a pass rate
  over 50 tasks, not for a verdict on any one task.

The README's benchmark images and table come from [`docs/assets/src/benchmarks.json`](assets/src/benchmarks.json).
After changing it, render the images again with `node scripts/readme-assets.mjs`.

We will publish each release's numbers here, with the date and the version measured.

## Running your own checks

The repository's tests include end-to-end checks against local test pages; they need your own keys and skip themselves
without them (see [CONTRIBUTING.md](../CONTRIBUTING.md)). If you find a site or task where the agent does badly, open an
issue with the task and the outcome: these become eval cases.
