# Online-Mind2Web: our own runs, as recorded

These are pilotfish's own runs on tasks from Online-Mind2Web (OSU NLP Group; 300 live tasks across 136 sites). They are
not a leaderboard submission and not a run of all 300 tasks. We keep them public so anyone can see what we measured,
including where we trailed.

Every run was scored by WebJudge, Online-Mind2Web's LLM judge, which reads the run's screenshots. WebJudge is often
wrong on single runs, so treat small differences as noise.

## 60 tasks, two trials, 25 Oct 2026 (`60-tasks-2026-10-25.csv`)

- **Tasks:** a fixed set of 60 Online-Mind2Web tasks, chosen before these runs.
- **pilotfish:** the hosted agent as it was on 25 Oct 2026, on Claude models (since replaced by GPT-6 Luna), two trials
  (A and B) of all 60 tasks.
- **Compared with:** the open-source browser-use agent 0.13.11 on Claude Sonnet 5, one trial. Not Browser Use Cloud.
- **Machine:** one machine in India, no proxy.

| | pilotfish (120 runs) | browser-use 0.13.11 (60 runs) |
|---|---|---|
| Passed (WebJudge) | 72 of 120 (60.0%) | 38 of 60 (63.3%) |
| Refused by a site's bot check | 16 runs | 0 runs |
| Seconds per task, median / mean | 54 / 84 | 136 / 156 |
| Model cost per task, median / mean | $0.095 / $0.210 | $0.305 / $0.376 |
| Model calls per task, median / mean | 10 / 12.9 | 10 / 13.2 |

browser-use passed 3.3 points more, within the run-to-run spread of this task set (about ±8 points). pilotfish took
less time and less model spend per task.

## 10 tasks on GPT-6 Luna, 18 Nov 2026 (`luna-check-2026-11-18.csv`)

A small check of the current agent on GPT-6 Luna (agent and judge), one trial. The 10 tasks were picked by a fixed
rule: the ones we had run most often that had never been blocked or errored before, one per site. That rule leaves out
sites that block us, so this is not a sample of the benchmark.

| | pilotfish on GPT-6 Luna |
|---|---|
| Passed (WebJudge) | 6 of 10 |
| Blocked | 0 |
| Seconds per task, mean | 119 |
| Model cost per task, mean | $0.008 |

Too few tasks to compare with anything; it is here as a record.

## Columns

`task_id` (Online-Mind2Web's id), `arm`, `trial`, `pass` (WebJudge), `blocked`, `seconds` (agent time), `model_calls`,
`cost_usd` (model spend), `stop` (why the run ended: `done`, `max_steps`, `timeout`, `max_failures`, ...).
