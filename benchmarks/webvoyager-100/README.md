# WebVoyager-100: pilotfish open MCP against Playwright MCP

On 3 Nov 2026 LangChain compared browser toolsets on 100 vetted WebVoyager tasks ("How we optimized browser use for Deep
Agents", full setup in langchain-ai/deepagents PR 6868). pilotfish was not in that comparison. This folder reruns their
setup with the pilotfish open MCP beside Playwright MCP, their baseline, and keeps every row of the run.

## What is the same as LangChain's run

Copied from PR 6868 at commit `5872275`, `browser-mda/benchmarks/webvoyager/` (MIT):

- the 100 tasks, `webvoyager_100.jsonl`, byte for byte;
- the task prompt, the system prompt and the Playwright MCP arm (`@playwright/mcp@0.0.84 --headless --isolated`);
- the 600 s cap per task and the recursion limit of 200;
- the judge's two questions and their criteria, word for word: BLOCKED when the site walled the agent, otherwise
  CORRECT or INCORRECT.

## What is different

- **Model:** GPT-6 Luna drives both arms and is also the judge. LangChain ran Claude Sonnet 5.5 with its own judge, so
  these rows compare with each other, not with LangChain's published table.
- **Machine:** one Windows machine in India, no proxy, headless. Each task ran on both arms at the same moment against
  the same live pages, five tasks at a time. Some answers show prices in ₹ because the sites served India.
- **No LangSmith:** tasks are read from the JSONL file and results written to `results/`.
- **One MCP session per task**, so the browser keeps its state between tool calls.
- **Arms:** Playwright MCP 0.0.84 and `@gaiventures/pilotfish-mcp@0.1.39` (the npm release of 11 Nov 2026).

## Results, 11 Nov 2026 (`results/2026-11-11-luna.jsonl`)

| | pilotfish open MCP | Playwright MCP |
|---|---|---|
| Correct | 66 | 63 |
| Incorrect | 6 | 12 |
| Blocked by the site | 24 | 20 |
| Error before the first model turn | 4 | 5 |
| Median input tokens per task | 24.1K | 85.5K |
| Median tool calls per task | 4.5 | 10 |
| Median seconds per task | 94.7 | 107.2 |
| Median model cost per task | $0.00096 | $0.00232 |

Medians are over the tasks that ran (96 for pilotfish, 95 for Playwright MCP); the errored tasks are left out. Seconds
include the shared load of five tasks running at once. Model cost uses GPT-6 Luna's list price at the time: $0.10 per
million input tokens, $0.01 cached, $0.50 output.

Each row of the results file is one task on one arm: `task`, `site`, `arm`, `answer`, `grade`, `model_turns`,
`tool_calls`, `tool_chars` (characters the tools returned), `in_tok`, `cached_tok`, `out_tok`, `usd`, `seconds`,
`status`.

## Run it yourself

```bash
export OPENAI_API_KEY=...
uv run --with langchain --with langchain-openai --with langchain-mcp-adapters --with httpx \
  python run.py --concurrency 3 --budget 2 --out results/<date>-luna.jsonl
python run.py --summary --out results/<date>-luna.jsonl
```

`--arms`, `--ids`, `--limit` and `--headed` narrow or change the run; `PF_MCP_VERSION` picks another pilotfish
release. The runner resumes: a row already in the output file is not run again. Live sites change, so expect your
numbers to move; please open an issue with yours, whichever way they go.
