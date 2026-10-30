# Evals

How we measure Drex Browser Use's accuracy and cost. The eval harness runs privately, because it uses the maintainers'
credentials and infrastructure; this page describes what it measures so the numbers can be read and questioned.

## Benchmarks

| Benchmark | What it tests | How a task is graded |
| --- | --- | --- |
| [WebArena-Verified](https://github.com/ServiceNow/webarena-verified) v1.2.3 | Multi-step tasks on self-hosted copies of three sites: an online shop (searching, comparing, order history, reviews), the shop's admin panel (orders, products, customers, reports, settings) and a Reddit-like forum (posting, commenting, voting, subscribing, finding posts) | The benchmark's own evaluator, from the agent's answer and the site's network traffic |
| [MiniWoB++](https://github.com/Farama-Foundation/miniwob-plusplus) | Short tasks on small synthetic pages: dates and times, autocomplete, menus, sliders, drawing, games, forms and mail | The page's own reward |

## How the 0.1.6 comparison was run

Three agents ran the same tasks on the same machine on 30 October 2026, all with the same LLM, Claude Haiku 5.5:

- **Drex Browser Use, Loop mode** (0.1.6, built with `DREX_MODE=loop`): the LLM holds the task and decides each step;
  Drex Max carries the steps out.
- **Drex Browser Use, default mode** (as in 0.1.5; 0.1.6 doesn't change it): Drex Max takes every action, the LLM
  plans, reads and checks.
- **Claude Code** 2.1.289 with Claude Haiku 5.5 and its usual tools (Bash, Read, Write, Edit, Glob, Grep), driving a
  Chromium window the harness opened with Playwright scripts it writes. No Drex, no browser MCP. Its prompt also asked
  for the answer in WebArena-Verified's JSON answer format (on MiniWoB++ too) and told it it had 600 seconds.

Every attempt got a freshly reset site, the same task, a 1280×800 page and the same 300-second clock (the extension
stops its own work at 270 seconds on WebArena-Verified, to leave time for its answer), and was graded by the
benchmark's own grader after the agent stopped. An attempt that ran out of time, crashed, never started or whose answer
the grader could not read counts as failed, and a model's own "done" never counts as a pass. Claude Code's harness gave
it 600 seconds, so its passes after 300 seconds are scored as failures (one on each benchmark), and its cost and time
are counted up to 300 seconds (5 attempts on WebArena-Verified and 2 on MiniWoB++ ran longer). No attempt was retried,
except three Claude Code attempts on MiniWoB++ that its eval harness's own budget guard stopped mid-run; each was run
once more, and all three passed.

**WebArena-Verified**: 60 tasks, 30 on the admin panel and 30 on the forum, two tries each. None of them had been used
by us before, though 59 share a task template (the same kind of task with other details) with tasks we had used. They
were picked from the benchmark's metadata by a fixed seed, balanced over templates, before any attempt ran, and none of
them was used to develop the code under test: Loop mode's point and drag actions came from its MiniWoB++ failures. The
shop has no unused single-site tasks left, so this set has none. 59 of the 60 tasks change something on the site (the
other opens a page), because the unused tasks that only read had run out; the full benchmark has more reading tasks than
this. Loop mode, the default mode and Claude Code each ran in a run of their own on the same machine the same afternoon,
each attempt on its own freshly reset copy of the site. Loop mode ran beside the Loop build it came from (the same code
before this release's last review fixes) as a check on the runs: 77 and 78 of 120. That earlier build had passed 82 of
120 in a run of its own, so a few tasks either way between runs is noise. On one task (699) the benchmark's own grader
fails with an error whatever the agent did; it counts as failed for all three agents.

**MiniWoB++**: 39 task types × seeds 1 and 2 (78 problems), two tries each. A problem passes when the page's own reward
is exactly 1, for every agent; a partial reward (a click near the target, a wrong click after the first of five numbers)
is a failure. Counting any positive reward as a pass instead gives Loop mode 81%, the default mode 67% and Claude Code
88%. The default mode was tuned on these problems. Loop mode's point and drag actions were added after a run on these
problems showed it failing their drag and canvas types, and were tried on another seed of those types before the run
measured here, so these numbers flatter them. One more type, `email-inbox-forward-nl`, is left out for every agent: the
Claude Code harness can't read its instruction. Loop mode ran in one run, beside the Loop build it came from (118 of 156
each); the default mode in another, beside that same earlier build (117 of 156 there); and Claude Code in a third, all
on the same machine and day.

**Cost** is what the tokens each run used cost at the providers' API list prices on 30 October 2026: Claude Haiku 5.5
at $0.10 input, $0.50 output, $0.01 cache reads and $0.125 / $0.20 cache writes per million tokens (five times that for
prompts over 100,000 tokens), and Drex Max at $0.03 per million input tokens. For Claude Code it is recomputed from
the token counts of each request, because the CLI's own cost line has no price for Haiku 5.5. It excludes the cost of
running the browser and the sites.

**Time** is the mean time a task took from the moment the agent was given it to its answer.

## Latest results

0.1.6, 30 October 2026. A try is one attempt at one task; the pass rate counts every scheduled try, and cost and time
are per try, up to the 300-second clock.

| Benchmark | Agent | Tasks × tries | Pass rate | $ per 1,000 tasks | s per task |
| --- | --- | ---: | ---: | ---: | ---: |
| WebArena-Verified, 60 new tasks (admin panel, forum) | **Drex Browser Use, Loop mode** | 60 × 2 | 64% (77 of 120) | 5.92 | 53 |
|  | Drex Browser Use, default mode | 60 × 2 | 58% (70 of 120) | 7.49 | 70 |
|  | Claude Code with Claude Haiku 5.5 | 60 × 2 | 78% (93 of 120) | 7.53 | 91 |
| MiniWoB++, 78 problems (39 task types) | **Drex Browser Use, Loop mode** | 78 × 2 | 76% (118 of 156) | 2.58 | 24 |
|  | Drex Browser Use, default mode | 78 × 2 | 60% (93 of 156) | 2.45 | 18 |
|  | Claude Code with Claude Haiku 5.5 | 78 × 2 | 84% (131 of 156) | 4.35 | 42 |

By site, WebArena-Verified:

| Site | Loop mode | Default mode | Claude Code |
| --- | ---: | ---: | ---: |
| admin panel | 29 of 60 (48%) | 25 of 60 (42%) | 40 of 60 (67%) |
| forum | 48 of 60 (80%) | 45 of 60 (75%) | 53 of 60 (88%) |

How to read these numbers:

- **Same LLM, different control loop.** All three agents use Claude Haiku 5.5. Loop mode passes 76% of MiniWoB++ against
  the default mode's 60%, +16.0 points (97.5% interval +3.2 to +28.2), and 64% of the new WebArena-Verified tasks
  against 58%, +5.8 points (97.5% interval −5.0 to +16.7: within this sample's noise).
- **Claude Code is more accurate.** It passes 78% of the new WebArena-Verified tasks, 13.3 points more than Loop mode
  (97.5% interval 5.0 to 23.3), and 84% of MiniWoB++, 8.3 points more (97.5% interval −3.2 to +21.2: within this
  sample's noise).
- **Loop mode costs less and is faster.** A WebArena-Verified task costs $5.92 per 1,000 tasks in Loop mode against
  $7.53 with Claude Code (21% less) and takes 53 seconds against 91; a MiniWoB++ problem costs $2.58 against $4.35 (41%
  less) and takes 24 seconds against 42. The default mode costs about the same as Loop mode on MiniWoB++ and is quicker
  there (18 seconds); on WebArena-Verified it costs more ($7.49) and takes longer (70 seconds).
- **Runs differ by a few tasks.** Loop mode passed 77 of the 120 WebArena-Verified tries; the build it came from passed
  78 beside it, and 82 in a run of its own. A gap of a few tasks between two agents in one run says little.
- **They are samples.** The intervals are paired bootstrap intervals over tasks (WebArena-Verified) and task types
  (MiniWoB++), keeping both tries of a task together: two tries at one task are not two independent tasks.
- **They are not the whole benchmark.** The new WebArena-Verified tasks come from two of its sites and almost all of
  them change something; tasks that only read, and the shop, are not in this set.
- **Loop mode is experimental.** Release builds don't include it yet (see the [CHANGELOG](../CHANGELOG.md)).

The README's benchmark image and table come from [`docs/assets/src/benchmarks.json`](assets/src/benchmarks.json).
After changing it, render the images again with `node scripts/readme-assets.mjs`.

## Earlier results

Drex Browser Use 0.1.0 (default mode), 20 October 2026, against coding agents measured on 19 and 20 October 2026 with
the same tasks, graders and machine. These used a different MiniWoB++ set (10 task types × 2 seeds), only the shop's 10
development tasks on WebArena-Verified, Drex Max at its then price of $0.06 per million input tokens, and a 600-second
limit for the coding agents.

| Benchmark | Agent | Tasks × tries | Pass rate | $ per task | s per task |
| --- | --- | ---: | ---: | ---: | ---: |
| WebArena-Verified, shop development set (10 tasks) | Drex Browser Use 0.1.0 | 10 × 4 | 73% (29 of 40) | 0.0041 | 36 |
| | Claude Code with Claude Haiku 5.5 | 10 × 2 | 85% (17 of 20) | 0.0084 | 89 |
| | Codex with gpt-6-luna | 10 × 2 | 70% (14 of 20) | 0.0054 | 69 |
| | Claude Code with Claude Sonnet 5.5 | 10 × 1 | 90% (9 of 10) | 0.074 | 55 |
| | Codex with gpt-6.1-sol | 10 × 1 | 80% (8 of 10) | 0.073–0.103 | 59 |
| MiniWoB++ (20 problems) | Drex Browser Use 0.1.0 | 20 × 2 | 98% (39 of 40) | 0.0013 | 12 |
| | Claude Code with Claude Haiku 5.5 | 20 × 2 | 90% (36 of 40) | 0.0038 | |
| | Codex with gpt-6-luna | 20 × 2 | 80% (32 of 40) | 0.0025 | |
| | Claude Code with Claude Sonnet 5.5 | 20 × 2 | 88% (35 of 40) | 0.024 | |
| | Codex with gpt-6.1-sol | 20 × 2 | 98% (39 of 40) | 0.028 | |

We publish each release's numbers here, with the date and the version measured.

## Running your own checks

The repository's tests include end-to-end checks against local test pages; they need your own keys and skip themselves
without them (see [CONTRIBUTING.md](../CONTRIBUTING.md)). If you find a site or task where the agent does badly, open an
issue with the task and the outcome: these become eval cases.
