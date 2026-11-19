# pilotfish for Python

Run browser tasks in [pilotfish](https://pilotfish.gai.ventures)'s cloud from Python, or drive Chrome on your own
machine.

pilotfish's agent and its open MCP send a page to the model as a compact outline with refs (`[e12]<button>Search`),
and after each step only what changed, never the whole page again. That means far fewer tokens per step and faster
steps than screenshots or raw HTML.

Two clients in one package:

- **`Pilotfish`** (and **`AsyncPilotfish`**): the hosted client. Describe a task in words; pilotfish's agent runs it in
  a cloud browser (signed in with saved logins, bot checks handled, a person asked only when needed) and returns the answer, as text or as JSON matching your schema. Paid from your org's credits.
- **`LocalBrowser`**: Chrome on your own machine and IP, driven step by step from your code through the open MCP's
  browser tools. No account, no API key, no model calls.

```bash
pip install pilotfish
```

Python 3.9 or newer. The only dependency is [httpx](https://www.python-httpx.org/).

## Hosted quickstart

Make an API key in the app at <https://pilotfish.gai.ventures> (Org settings → API keys) and set it as
`PILOTFISH_API_KEY`.

```python
from pilotfish import Pilotfish

pf = Pilotfish()  # reads PILOTFISH_API_KEY; or Pilotfish(api_key="pf_...")

task = pf.tasks.run("Find the cheapest blue desk lamp on ikea.com and give its name and price")
print(task["status"])            # done, failed, cancelled, or needs_input
print(task["result"]["result"])  # the answer, in words
```

Responses are the API's own JSON as plain dicts, with the API's field names (`startUrl`, `threadId`, `costUsd`...).
Request bodies take the API's names too, as a dict or as keyword arguments; query options are snake_case keyword
arguments:

```python
pf.tasks.create("Read my loyalty points", startUrl="https://shop.example/account", maxSteps=30, region="us")
pf.tasks.create({"task": "Read my loyalty points", "startUrl": "https://shop.example/account"})
pf.tasks.list(status="done", limit=20)
```

`Pilotfish(...)` takes `api_key`, `base_url` (default `PILOTFISH_BASE_URL`, else `https://pilotfish-be.gai.ventures`),
`max_retries` (2), `timeout` (60 s per request) and `http_client` (your own `httpx.Client`). Use it as a
context manager to close its connections: `with Pilotfish() as pf: ...`.

## Tasks

```python
t = pf.tasks.create("How many loyalty points do I have?", startUrl="https://shop.example/account")
print(t["id"], t["appUrl"])                 # watch it live in the app

for event in pf.tasks.stream(t["id"]):      # each new event (steps, questions, files) until it ends
    print(event["type"])

done = pf.tasks.wait(t["id"])               # until it ends, or waits on a question
```

- `tasks.run(task, **fields)` starts a task and waits; `tasks.wait(id, timeout=1800, poll_interval=2)` returns when
  the task ends or asks a question (`return_on_question=False` waits for the end). A wait that times out raises
  `WaitTimeoutError`; the task carries on.
- `tasks.get(id)`, `tasks.list(status=, limit=, cursor=, project=, identity=)` (one page: `.items`, `.next_cursor`),
  `tasks.iterate(...)` (every task, page after page), `tasks.events(id, after=None)`.
- `tasks.follow_up(id, "now add the chair")` gives the next instruction in the same session: the same browser while
  it is kept, the same sign-ins, what earlier turns found.
- `tasks.continue_(id)` carries a paused task on (`paused: True`, `next: "continue"`), as the app's Continue does.
  (The trailing underscore is because `continue` is a Python keyword.)
- `tasks.answer(id, question_id, answer)` answers the open question (`task["question"]["id"]`): `"yes"`, `"no"`,
  `"done"`, `"cancel"`, any other text, or an answer dict. Codes and passwords go on the task's `answerUrl`, never
  through the API.
- `tasks.message(id, "use the cheaper one")` tells a running task something; it reads it before its next step.
- `tasks.cancel(id)`, `tasks.pause(id)` / `tasks.resume(id)` (take the browser over and hand it back),
  `tasks.rerun(id)`, `tasks.thread(id)`, `tasks.delete_session(id)`.
- Files and replays: `tasks.files(id)`, `tasks.download_file(id, file_id)` and `tasks.replay_mp4(id)` return
  `(data, content_type, filename)`, and `tasks.frames(id)` the screenshots after each step that changed the page.

```python
t = pf.tasks.wait(t["id"])
if t["status"] == "needs_input":
    q = t["question"]
    print(q.get("text") or q.get("question"))
    pf.tasks.answer(t["id"], q["id"], "yes")
```

## Structured output

Give a JSON Schema (root `type: "object"`) and the result's `data` validates against it:

```python
t = pf.tasks.run(
    "List the first three laptops on the page with their prices",
    startUrl="https://shop.example/laptops",
    outputSchema={
        "type": "object",
        "properties": {"laptops": {"type": "array", "items": {
            "type": "object",
            "properties": {"name": {"type": "string"}, "price": {"type": "number"}},
            "required": ["name", "price"],
        }}},
        "required": ["laptops"],
    },
)
print(t["result"].get("data") or t["result"].get("dataError"))
```

## Batches

Many tasks in one request, run one after another, their results collected together (up to 100). Each task is
charged when it runs; if credits run out, the rest are skipped.

```python
batch = pf.batches.run(
    ["What is on the front page of example.com?", {"task": "Read the points", "startUrl": "https://shop.example/a"}],
    name="nightly",
    webhookUrl="https://you.example/pilotfish",   # batch.finished, signed
)
for item in batch["items"]:
    print(item["status"], (item["result"] or {}).get("result"))
```

`batches.create`, `batches.get`, `batches.wait(id, timeout=7200)`, `batches.list(status=, limit=, cursor=)` and
`batches.cancel` (the running task is cancelled, the rest skipped and never charged).

## Identities and login links

For a product with its own end users: in a shared project (an org key's project), each identity keeps its own logins,
sessions, IP address and device.

```python
org = Pilotfish(api_key="pf_org_key")
ada = org.identities.create(externalUserId="user-42", label="Ada")   # existed: True if you had it already
link = org.identities.login_link(ada["id"], ["example.com"])          # a one-time page where Ada types her own login
print(link["url"])
org.identities.add_credential(ada["id"], site="example.com", username="ada@example.com", password="...")
org.tasks.run("Download my latest invoice", identity=ada["id"], startUrl="https://example.com/billing")
```

Also `identities.get`, `list(external_user_id=, q=, limit=, cursor=)` (with `.total`), `update` (PATCH), `delete`
(wipes its logins, sessions and device; its tasks and cost are kept), `usage(id, since=<ms since the epoch>)`, `credentials` (masked: never the
password), `set_default_credential` and `delete_credential`.

## Saved tasks and schedules

```python
saved = pf.saved_tasks.create(name="points", task="How many loyalty points do I have?",
                              options={"startUrl": "https://shop.example/account"})
run = pf.saved_tasks.run(saved["id"], extraInstructions="also the expiry date")
pf.schedules.create(savedTaskId=saved["id"], rule={"repeat": "weekdays", "time": "09:00", "tz": "Europe/London"})
```

Saved tasks and schedules live in your Personal project (an org key's shared project has none: `ConflictError` with
code `shared_project`). What would stop a scheduled run with nobody there is settled before it is saved
(`ConflictError` with code `not_ready`).

## Usage

```python
pf.usage.get(days=7)                              # spending by kind, day, model and task, and what is left of an allowance
pf.usage.get(from_="2026-11-01", to="2026-11-30")
```

## Errors and retries

Every API error is raised as its class, with the API's `code`, `hint`, `docs`, `fields` (the invalid parts of a 400),
`retry_after_s` and the whole `body`:

| Class | Status | For example |
| --- | --- | --- |
| `BadRequestError` | 400, 422 | `invalid_request` with `fields`, `invalid_schema` |
| `AuthenticationError` | 401 | no key, a wrong or revoked one |
| `PaymentRequiredError` | 402 | `no_credits`, `allocation_used`, `org_limit` |
| `PermissionDeniedError` | 403 | `admins_only` |
| `NotFoundError` | 404, 410 | no such task, batch or identity |
| `ConflictError` | 409 | `one_session`, `identity_busy`, `shared_project` |
| `RateLimitError` | 429 | `rate_limited`, `queue_full`, `start_rate` |
| `ServerError` | 5xx | |
| `ConnectionError` | (0) | no answer: the network, or the client's timeout |
| `WaitTimeoutError` | (0) | `wait()` gave up; the task carries on |

All are `PilotfishError`s.

```python
from pilotfish import PaymentRequiredError, PilotfishError

try:
    pf.tasks.create("...")
except PaymentRequiredError as e:
    print(e.code, e.hint)        # no_credits, who to ask
except PilotfishError as e:
    print(e.status, e.code, e)
```

The client retries by itself: a 429 for any request, after its `retryAfterS` (or `Retry-After`, at most 60 s), since
nothing was made; a 5xx or a network failure only for reads (GET), so a task is never started twice. `max_retries`
(default 2) sets how many tries follow the first.

## Webhooks

A task's `webhookUrl` gets `job.needs_input` and `job.finished`, a batch's `batch.finished`, an identity's login link
`identity.login_saved`. Each delivery carries `Pilotfish-Signature: t=<unix>,v1=<hex>`, the HMAC-SHA256 of
`"<t>.<raw body>"` with your org's webhook secret (Org settings, or `GET /org/webhook-secret`). Check it on the raw
body, exactly as received:

```python
from pilotfish import parse_webhook, verify_webhook

ok = verify_webhook(secret, request.headers.get("Pilotfish-Signature"), raw_body)  # True or False; 5 minutes' tolerance
event = parse_webhook(secret, request.headers.get("Pilotfish-Signature"), raw_body)  # or raises (code bad_signature)
print(event["type"], event.get("jobId") or event.get("batchId"), event["data"])
```

`sign_webhook(secret, body, t=None)` makes a header, for tests of your own endpoint.

## Async

`AsyncPilotfish` has the same surface, every call awaited; `tasks.iterate` and `tasks.stream` are async iterators.

```python
import asyncio
from pilotfish import AsyncPilotfish

async def main():
    async with AsyncPilotfish() as pf:
        t = await pf.tasks.run("What is on the front page of example.com?")
        print(t["result"]["result"])
        async for event in pf.tasks.stream(t["id"]):
            print(event["type"])

asyncio.run(main())
```

## Local quickstart

`LocalBrowser` drives Chrome on your own machine with the open MCP's tools
([@gaiventures/pilotfish-mcp](https://www.npmjs.com/package/@gaiventures/pilotfish-mcp), MIT). It needs Node.js 22+
and Chrome; it starts `npx -y @gaiventures/pilotfish-mcp` (or `node $PILOTFISH_MCP_CLI`, or the `command=` you
give) and speaks MCP to it over stdio. No key and no model calls: your code decides each step.

```python
import re
from pilotfish import LocalBrowser

with LocalBrowser.start() as b:
    page = b.navigate("https://en.wikipedia.org")
    print(page.text)                                     # the visible screen as an outline with refs
    box = re.search(r"\[(e\d+)\]", b.find("Search Wikipedia").text).group(1)
    b.type(box, "Pilot fish", submit=True)
    headings = b.query("[...document.querySelectorAll('h2')].map((h) => h.textContent.trim())")
    print(headings.value)                                # parsed JSON
    open("page.jpg", "wb").write(b.screenshot())
```

Tools: `navigate(url, snapshot=, expect=, escalate=)`, `snapshot(whole_page=False)`, `click(ref)`,
`type(ref, text, submit=)`, `select(ref, values)`, `press(key)`, `scroll(direction)`, `actions(steps)` (up to 10 in
one call), `query(expression, schema=)` (`.value`), `find(query)`, `get_text(max_chars=, selector=)`,
`screenshot()` (JPEG bytes), `wait(seconds, until=, gone=, in_=)`, `resume(timeout_s=)`, `tabs(switch_to=)`,
`page_tool(tool, arguments)`, `tools()`, and `call(name, args)` for any tool by name. Each returns a `ToolResult`
(`text`, `images`, `structured`, `is_error`); a tool's error raises `LocalToolError` (with `.tool` and `.result`)
unless `throw_on_error=False`.

`LocalBrowser.start(...)` takes `headless`, `allowed_hosts`, `allow_private` (localhost and private networks, for
testing your own app), `secrets` (typed as `{{name}}`, never in any result), `chrome`, `env` (further
[settings](https://pilotfish.gai.ventures/docs/open-settings)), `command`, `timeout` (per call, 300 s) and
`on_question`. Without `on_question` an irreversible step (pay, send, delete) is refused and a page that needs a
person says so in the result. With it, you decide:

```python
def on_question(q):          # q.kind is "confirm" (an irreversible step) or "handoff" (a sign-in, code or CAPTCHA)
    print(q.message)
    return input("Allow? [y/N] ").lower() == "y"   # True allows (or, for a handoff, says it is done); None or False declines

b = LocalBrowser.start(on_question=on_question)
```

## Links

- SDK documentation: <https://pilotfish.gai.ventures/docs/sdk>
- REST API reference: <https://pilotfish.gai.ventures/docs/api>
- Source: <https://github.com/gAI-ventures/pilotfish-ai/tree/main/sdks/python>

MIT licensed.
