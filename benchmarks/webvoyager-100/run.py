"""LangChain's WebVoyager-100 browser-toolset benchmark, rerun on gpt-6-luna.

Source: langchain-ai/deepagents PR 6868 (commit 5872275), browser-mda/benchmarks/webvoyager/
(MIT). Copied verbatim from there: the 100 tasks (webvoyager_100.jsonl), the task prompt (PROMPT),
the system prompt (INSTRUCTIONS), the Playwright MCP arm, the 600 s cap per task, the recursion
limit of 200, and the judge's two questions with their criteria (JEV_QUESTIONS).

Changed, and why:
- Model: openai:gpt-6-luna for the agent and the judge. LangChain ran claude-sonnet-5-5 and its
  own judge, so these rows compare with each other, not with LangChain's published table.
- No LangSmith: tasks come from the JSONL and results go to a local JSONL file.
- One MCP session per task (`client.session`), so browser state lasts across tool calls.
- Arms of one task run at the same time, so they meet the same live pages.
- Spend is capped: --budget (USD) for this invocation.
- OPENAI_API_KEY must be set in the environment.

    uv run --with langchain --with langchain-openai --with langchain-mcp-adapters --with httpx \
        python run.py --arms pilotfish,playwright --limit 2 --budget 0.5 --out results/smoke.jsonl
"""

from __future__ import annotations

import argparse
import asyncio
import datetime as dt
import json
import os
import re
import shutil
import statistics
import sys
import time
from pathlib import Path

from langchain.agents import create_agent
from langchain_core.messages import AIMessage, ToolMessage
from langchain_mcp_adapters.client import MultiServerMCPClient
from langchain_mcp_adapters.tools import load_mcp_tools
from langchain_openai import ChatOpenAI

HERE = Path(__file__).resolve().parent
MODEL = "gpt-6-luna"
# USD per million tokens for gpt-6-luna (OpenAI's list price when these runs were made).
PRICE = {"in": 0.10, "cached": 0.01, "out": 0.50}
MAX_SECONDS = 600

NPX = shutil.which("npx") or "npx"
ARMS: dict[str, dict] = {
    "playwright": {
        "command": NPX,
        "args": ["-y", "@playwright/mcp@0.0.84", "--headless", "--isolated"],
        "transport": "stdio",
    },
    "pilotfish": {
        "command": NPX,
        "args": ["-y", f"@gaiventures/pilotfish-mcp@{os.environ.get('PF_MCP_VERSION', '0.1.39')}"],
        "transport": "stdio",
        "env": {**os.environ, "PILOTFISH_HEADLESS": "1"},
    },
}


def headed() -> None:
    """--headed: a visible browser window, each MCP's own default where a display exists (9 Nov: headless, Allrecipes
    and Google Search bot-walled every task; headed, both loaded)."""
    for name, arm in ARMS.items():
        if name.startswith("pilotfish"):
            arm["env"] = {**arm["env"], "PILOTFISH_HEADLESS": "0"}
        else:
            arm["args"] = [a for a in arm["args"] if a != "--headless"]

# --- verbatim from experiment_native.py / bench_local.py -------------------------------------
PROMPT = """{ques}

Start at {web}
Answer the question directly and concisely. If after a genuine effort the site
blocks you or the information is not available, say exactly why. Do not guess."""

ANSWER_RULES = """Answer directly and concisely, from what the page actually showed.
If the site blocks you or the information is not there, say exactly that and
why. Never guess a value you did not read."""

INSTRUCTIONS = "Browse with the tools you have been given to answer the question.\n\n" + ANSWER_RULES

JEV_QUESTIONS = {
    "correct": {"instructions": "Does the answer give what the task asked for, taken from the site?",
                "criteria": {
                    "true": "The answer supplies what was asked. Current values that differ from "
                            "the reference are fine: the reference records one acceptable answer "
                            "against data that changes. Reporting, from the site, that the thing "
                            "does not exist also counts. A caveat noting what was not checked, "
                            "added after a definite answer, does not take the answer away.",
                    "false": "Something asked for is never given, or the answer is hedged so that "
                             "no definite value lands, or a value was guessed, recalled, or worked "
                             "out without visiting the site."}},
    "blocked": {"instructions": "Did the site stop the agent reaching the content?",
                "criteria": {"true": "A bot wall, captcha, login, 403 or stripped parameters "
                                     "blocked it.",
                             "false": "The agent reached the content it needed."}},
}
_PLACEHOLDER = re.compile(r"<[^<>]{1,40}>")
# ---------------------------------------------------------------------------------------------


class Spend:
    """This invocation's spend, against --budget."""

    def __init__(self, budget: float):
        self.budget, self.total = budget, 0.0

    def check(self) -> None:
        if self.total >= self.budget:
            raise RuntimeError(f"budget ${self.budget:.2f} reached (${self.total:.4f})")

    def add(self, usd: float) -> None:
        self.total += usd


def cost_of(usage: dict) -> tuple[int, int, int, float]:
    tin = usage.get("input_tokens", 0) or 0
    tout = usage.get("output_tokens", 0) or 0
    cached = (usage.get("input_token_details") or {}).get("cache_read", 0) or 0
    usd = ((tin - cached) * PRICE["in"] + cached * PRICE["cached"] + tout * PRICE["out"]) / 1e6
    return tin, cached, tout, usd


def llm() -> ChatOpenAI:
    return ChatOpenAI(model=MODEL, use_responses_api=True, timeout=120, max_retries=2)


async def judge(ques: str, answer: str, outputs: dict, spend: Spend) -> dict:
    ref = (outputs.get("reference_answer") or "").strip()
    ref_block = f"REFERENCE ANSWER (type: {outputs.get('answer_type')})\n{ref}"
    if _PLACEHOLDER.search(ref):
        ref_block += ("\n\nNOTE: text in <angle brackets> above is an unfilled slot in the "
                      "reference, not content the answer has to reproduce. Judge that part "
                      "against the task and the site.")
    state = f"TASK\n{ques}\n\n{ref_block}\n\nAGENT ANSWER\n{answer[:6000]}"
    qs = "\n\n".join(
        f'"{k}": {v["instructions"]}\n  true when: {v["criteria"]["true"]}\n  false when: {v["criteria"]["false"]}'
        for k, v in JEV_QUESTIONS.items())
    sys_msg = ("You grade a web agent's final answer. Answer each question true or false using its "
               "criteria. Reply with JSON only: {\"correct\": true|false, \"blocked\": true|false}.")
    spend.check()
    msg = await llm().ainvoke([("system", sys_msg), ("user", f"{state}\n\nQUESTIONS\n{qs}")])
    spend.add(cost_of(msg.usage_metadata or {})[3])
    text = msg.content if isinstance(msg.content, str) else " ".join(
        b.get("text", "") for b in msg.content if isinstance(b, dict))
    m = re.search(r"\{.*\}", text, re.S)
    v = json.loads(m.group(0)) if m else {}
    return {"correct": bool(v.get("correct")), "blocked": bool(v.get("blocked"))}


async def run_one(arm: str, row: dict, spend: Spend) -> dict:
    inp, outputs = row["inputs"], row.get("outputs") or {}
    t0 = time.time()
    rec = {"arm": arm, "task": inp["task_id"], "site": inp["site"], "status": "ok", "answer": "",
           "model_turns": 0, "tool_calls": 0, "tool_chars": 0, "in_tok": 0, "cached_tok": 0,
           "out_tok": 0, "usd": 0.0}
    try:
        spend.check()
        client = MultiServerMCPClient({arm: ARMS[arm]})
        async with client.session(arm) as session:
            tools = await load_mcp_tools(session)
            agent = create_agent(model=llm(), tools=tools, system_prompt=INSTRUCTIONS)
            state = await asyncio.wait_for(
                agent.ainvoke({"messages": [{"role": "user", "content": PROMPT.format(**inp)}]},
                              config={"recursion_limit": 200}),
                timeout=MAX_SECONDS)
        msgs = state["messages"]
        for m in msgs:
            if isinstance(m, AIMessage):
                rec["model_turns"] += 1
                rec["tool_calls"] += len(m.tool_calls or [])
                tin, cached, tout, usd = cost_of(m.usage_metadata or {})
                rec["in_tok"] += tin; rec["cached_tok"] += cached; rec["out_tok"] += tout
                rec["usd"] += usd
            elif isinstance(m, ToolMessage):
                c = m.content
                rec["tool_chars"] += len(c if isinstance(c, str) else json.dumps(c))
        c = msgs[-1].content
        if isinstance(c, list):
            c = " ".join(b.get("text", "") for b in c if isinstance(b, dict))
        rec["answer"] = (c or "").strip()
    except Exception as err:  # noqa: BLE001 - one task must not stop the suite
        rec["status"] = f"{type(err).__name__}: {str(err)[:160]}"
    # A run cut off by the timeout lost its message list; its spend is unknown, not zero.
    if rec["usd"]:
        spend.add(rec["usd"])
    rec["seconds"] = round(time.time() - t0, 1)
    grade = "ERROR"
    if rec["status"] == "ok" and rec["answer"]:
        try:
            v = await judge(inp["ques"], rec["answer"], outputs, spend)
            grade = "BLOCKED" if v["blocked"] else "CORRECT" if v["correct"] else "INCORRECT"
        except Exception as err:  # noqa: BLE001
            grade = "UNGRADED"
            rec["judge_error"] = str(err)[:160]
    rec["grade"] = grade
    print(f"[{grade:9}] {arm:10} {inp['task_id']:26} {rec['seconds']:6.0f}s "
          f"turns={rec['model_turns']:3} ${rec['usd']:.4f}"
          f"{'' if rec['status'] == 'ok' else '  ' + rec['status']}", flush=True)
    return rec


def summarize(path: Path) -> None:
    rows = [json.loads(x) for x in path.read_text().splitlines() if x.strip()]
    print(f"\n{'arm':10} {'n':>3} {'CORRECT':>7} {'BLOCKED':>7} {'INCORR':>6} {'ERR':>4} {'rate':>6} "
          f"{'medTurns':>8} {'medTokK':>7} {'medToolK':>8} {'total$':>8} {'medSecs':>7}")
    for arm in sorted({r["arm"] for r in rows}):
        rs = [r for r in rows if r["arm"] == arm]
        g = lambda k: sum(1 for r in rs if r["grade"] == k)  # noqa: E731
        med = lambda k: statistics.median(r[k] for r in rs)  # noqa: E731
        print(f"{arm:10} {len(rs):3} {g('CORRECT'):7} {g('BLOCKED'):7} {g('INCORRECT'):6} "
              f"{len(rs) - g('CORRECT') - g('BLOCKED') - g('INCORRECT'):4} "
              f"{100 * g('CORRECT') / len(rs):5.1f}% {med('model_turns'):8.0f} "
              f"{med('in_tok') / 1000:7.1f} {med('tool_chars') / 1000:8.1f} "
              f"{sum(r['usd'] for r in rs):8.3f} {med('seconds'):7.0f}")


async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--arms", default="pilotfish,playwright", help=f"comma-separated: {', '.join(ARMS)}")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--ids", default="", help="comma-separated task ids")
    ap.add_argument("--concurrency", type=int, default=3, help="tasks at once (each runs every arm)")
    ap.add_argument("--budget", type=float, required=True, help="USD cap for this invocation")
    ap.add_argument("--out", required=True)
    ap.add_argument("--summary", action="store_true", help="only print the summary of --out")
    ap.add_argument("--headed", action="store_true", help="visible browser windows (each MCP's default with a display)")
    a = ap.parse_args()
    if a.headed:
        headed()

    out = HERE / a.out
    if a.summary:
        summarize(out); return
    arms = [x.strip() for x in a.arms.split(",") if x.strip()]
    rows = [json.loads(x) for x in (HERE / "webvoyager_100.jsonl").read_text().splitlines() if x.strip()]
    if a.ids:
        want = set(a.ids.split(","))
        rows = [r for r in rows if r["inputs"]["task_id"] in want]
    if a.limit:
        rows = rows[: a.limit]
    out.parent.mkdir(parents=True, exist_ok=True)
    done = set()
    if out.exists():  # resume: never pay twice for a finished row
        done = {(r["arm"], r["task"]) for r in (json.loads(x) for x in out.read_text(encoding="utf-8").splitlines() if x.strip())}
    spend = Spend(a.budget)
    print(f"{len(rows)} tasks x {arms}, model {MODEL}, budget ${a.budget}", flush=True)
    sem = asyncio.Semaphore(a.concurrency)
    lock = asyncio.Lock()

    async def task(row):
        async with sem:
            todo = [arm for arm in arms if (arm, row["inputs"]["task_id"]) not in done]
            for rec in await asyncio.gather(*[run_one(arm, row, spend) for arm in todo]):
                async with lock:
                    with out.open("a", encoding="utf-8") as f:
                        f.write(json.dumps(rec) + "\n")

    await asyncio.gather(*[task(r) for r in rows])
    print(f"\nspent ${spend.total:.4f} this run")
    summarize(out)


if __name__ == "__main__":
    if sys.platform == "win32":
        asyncio.set_event_loop_policy(asyncio.WindowsProactorEventLoopPolicy())
    asyncio.run(main())
