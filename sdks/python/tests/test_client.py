"""The hosted clients (sync and async) against a scripted transport: requests as the API takes them, typed errors from
the error envelope, retries (429 after retryAfterS whatever the method; 5xx and network failures for reads only),
wait, stream, pages, batches, downloads. Mirrors packages/sdk/src/client.test.ts."""

from __future__ import annotations

import asyncio
import inspect
import json
from dataclasses import dataclass
from typing import Any, Callable, Dict, List, Optional

import httpx
import pytest

import pilotfish
import pilotfish.client as client_mod
from pilotfish import (
    AsyncPilotfish,
    AuthenticationError,
    BadRequestError,
    ConflictError,
    ConnectionError,
    NotFoundError,
    PaymentRequiredError,
    PermissionDeniedError,
    Pilotfish,
    PilotfishError,
    RateLimitError,
    ServerError,
    WaitTimeoutError,
)


@dataclass
class Call:
    method: str
    url: httpx.URL
    headers: Dict[str, str]
    body: Any


Answer = Callable[[httpx.Request], httpx.Response]


class Scripted:
    def __init__(self, answers: List[Answer]) -> None:
        self.answers = list(answers)
        self.calls: List[Call] = []

    def handler(self, request: httpx.Request) -> httpx.Response:
        content = request.read()
        self.calls.append(Call(request.method, request.url, dict(request.headers), json.loads(content) if content else None))
        if not self.answers:
            raise AssertionError(f"no answer scripted for {request.method} {request.url.path}")
        return self.answers.pop(0)(request)

    def client(self, mode: str = "sync", **o: Any) -> Any:
        transport = httpx.MockTransport(self.handler)
        if mode == "async":
            return AsyncPilotfish(api_key="pf_test", base_url="https://api.example/", http_client=httpx.AsyncClient(transport=transport), **o)
        return Pilotfish(api_key="pf_test", base_url="https://api.example/", http_client=httpx.Client(transport=transport), **o)


def scripted(*answers: Answer) -> Scripted:
    return Scripted(list(answers))


def js(body: Any, status: int = 200, headers: Optional[Dict[str, str]] = None) -> Answer:
    return lambda _r: httpx.Response(status, json=body, headers=headers or {})


def raw(content: bytes, status: int = 200, headers: Optional[Dict[str, str]] = None) -> Answer:
    return lambda _r: httpx.Response(status, content=content, headers=headers or {})


def fail(message: str = "fetch failed") -> Answer:
    def f(r: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError(message, request=r)

    return f


def job(**o: Any) -> Dict[str, Any]:
    return {"id": "job_1", "threadId": "job_1", "status": "queued", "task": "t", "question": None, "result": None, "createdAt": 1, "updatedAt": 1, "finishedAt": None, **o}


def resolve(x: Any) -> Any:
    """The value of a sync call, or of an async one run to its end."""
    return asyncio.run(x) if inspect.isawaitable(x) else x


def collect(it: Any) -> List[Any]:
    if hasattr(it, "__aiter__"):

        async def go() -> List[Any]:
            return [x async for x in it]

        return asyncio.run(go())
    return list(it)


def raises(x: Callable[[], Any]) -> BaseException:
    try:
        resolve(x())
    except BaseException as e:  # noqa: BLE001
        return e
    raise AssertionError("expected an exception")


@pytest.fixture(autouse=True)
def instant(monkeypatch: pytest.MonkeyPatch) -> List[float]:
    """No real waiting: every sleep is recorded instead."""
    slept: List[float] = []

    async def asleep(s: float) -> None:
        slept.append(s)

    monkeypatch.setattr(client_mod, "_sleep", lambda s: slept.append(s))
    monkeypatch.setattr(client_mod, "_asleep", asleep)
    return slept


MODES = ["sync", "async"]


def test_needs_a_key(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("PILOTFISH_API_KEY", raising=False)
    for cls in (Pilotfish, AsyncPilotfish):
        with pytest.raises(PilotfishError, match="No API key") as e:
            cls()
        assert e.value.code == "no_api_key"
    monkeypatch.setenv("PILOTFISH_API_KEY", "pf_env")
    monkeypatch.setenv("PILOTFISH_BASE_URL", "https://env.example//")
    pf = Pilotfish()
    assert pf.base_url == "https://env.example"
    assert pf._api_key == "pf_env"
    pf.close()
    monkeypatch.delenv("PILOTFISH_BASE_URL")
    assert Pilotfish().base_url == "https://pilotfish-be.gai.ventures"


@pytest.mark.parametrize("mode", MODES)
def test_sends_the_key_with_each_request_to_the_base_url(mode: str) -> None:
    s = scripted(js(job(), 201))
    t = resolve(s.client(mode).tasks.create({"task": "find the lamp", "maxSteps": 12, "outputSchema": {"type": "object"}}))
    assert t["id"] == "job_1"
    c = s.calls[0]
    assert c.method == "POST"
    assert str(c.url) == "https://api.example/jobs"
    assert c.headers["authorization"] == "Bearer pf_test"
    assert c.headers["user-agent"] == f"pilotfish-sdk-python/{pilotfish.__version__}"
    assert c.headers["content-type"] == "application/json"
    assert "x-pilotfish-project" not in c.headers
    assert "accept" in c.headers
    assert c.body == {"task": "find the lamp", "maxSteps": 12, "outputSchema": {"type": "object"}}


@pytest.mark.parametrize("mode", MODES)
def test_task_words_and_keyword_fields(mode: str) -> None:
    s = scripted(js(job(), 201), js(job()))
    c = s.client(mode)
    resolve(c.tasks.create("find the lamp", startUrl="https://shop.example", maxSteps=5))
    resolve(c.tasks.get("job/1"))
    assert s.calls[0].body == {"task": "find the lamp", "startUrl": "https://shop.example", "maxSteps": 5}
    assert s.calls[1].url.raw_path == b"/jobs/job%2F1"
    assert s.calls[1].body is None
    assert "content-type" not in s.calls[1].headers


ERROR_CASES = [
    (400, BadRequestError),
    (401, AuthenticationError),
    (402, PaymentRequiredError),
    (403, PermissionDeniedError),
    (404, NotFoundError),
    (409, ConflictError),
    (410, NotFoundError),
    (422, BadRequestError),
    (500, ServerError),
]


@pytest.mark.parametrize("mode", MODES)
@pytest.mark.parametrize("status,cls", ERROR_CASES)
def test_each_error_status_is_its_class_with_code_hint_docs_fields_and_body(mode: str, status: int, cls: type) -> None:
    fields = [{"path": "task", "message": "too short"}]
    s = scripted(js({"error": "nope", "code": f"c{status}", "hint": "do x", "docs": "https://d", "fields": fields, "balanceUsd": 0}, status))
    err = raises(lambda: s.client(mode, max_retries=0).tasks.create("x"))
    assert type(err) is cls
    assert isinstance(err, PilotfishError)
    assert (err.status, err.code, str(err), err.hint, err.docs, err.fields) == (status, f"c{status}", "nope", "do x", "https://d", fields)
    assert err.body["balanceUsd"] == 0
    assert err.retry_after_s is None


@pytest.mark.parametrize("mode", MODES)
def test_a_body_with_no_code_has_the_status_as_its_code(mode: str) -> None:
    s = scripted(raw(b"gateway", 502))
    err = raises(lambda: s.client(mode, max_retries=0).tasks.create("x"))
    assert isinstance(err, ServerError)
    assert err.code == "502"
    assert str(err) == "HTTP 502"
    t = scripted(raw(b"", 418))
    other = raises(lambda: t.client(mode, max_retries=0).tasks.create("x"))
    assert type(other) is PilotfishError and other.code == "418"


@pytest.mark.parametrize("mode", MODES)
def test_retries_a_429_after_its_retry_after_s_also_for_a_post(mode: str, instant: List[float]) -> None:
    s = scripted(js({"error": "slow down", "code": "start_rate", "retryAfterS": 0}, 429), js(job(), 201))
    assert resolve(s.client(mode).tasks.create("x"))["id"] == "job_1"
    assert [c.method for c in s.calls] == ["POST", "POST"]
    assert instant == [0]


@pytest.mark.parametrize("mode", MODES)
def test_gives_up_on_a_429_after_max_retries_with_a_zero_retry_after_header(mode: str, instant: List[float]) -> None:
    gives = scripted(*[js({"error": "slow down", "code": "rate_limited"}, 429, {"retry-after": "0"}) for _ in range(3)])
    err = raises(lambda: gives.client(mode).tasks.get("job_1"))
    assert isinstance(err, RateLimitError)
    assert err.retry_after_s == 0
    assert err.code == "rate_limited"
    assert len(gives.calls) == 3
    assert instant == [0, 0]


@pytest.mark.parametrize("mode", MODES)
def test_429_waits_are_capped_and_default_to_exponential(mode: str, instant: List[float]) -> None:
    s = scripted(js({"error": "x", "retryAfterS": 600}, 429), js({"error": "x"}, 429), js(job()))
    resolve(s.client(mode).tasks.cancel("job_1"))
    assert instant == [60, 2]
    assert [c.method for c in s.calls] == ["DELETE"] * 3


@pytest.mark.parametrize("mode", MODES)
def test_retries_5xx_and_network_failures_on_reads_only(mode: str, instant: List[float]) -> None:
    read = scripted(js({"error": "boom"}, 503), fail(), js(job(status="done")))
    assert resolve(read.client(mode).tasks.get("job_1"))["status"] == "done"
    assert instant == [0.5, 1.0]
    write = scripted(js({"error": "boom"}, 503))
    assert isinstance(raises(lambda: write.client(mode).tasks.create("x")), ServerError)
    down = scripted(fail())
    err = raises(lambda: down.client(mode).tasks.create("x"))
    assert isinstance(err, ConnectionError)
    assert err.status == 0 and err.code == "connection_error"
    assert isinstance(err.__cause__, httpx.ConnectError)
    gone = scripted(fail(), fail(), fail())
    assert isinstance(raises(lambda: gone.client(mode).tasks.get("job_1")), ConnectionError)
    assert len(gone.calls) == 3


@pytest.mark.parametrize("mode", MODES)
def test_waits_for_the_end_or_a_question_and_times_out_without_stopping_the_task(mode: str) -> None:
    s = scripted(
        js(job(status="running")),
        js(job(status="needs_input", question={"id": "q1", "kind": "confirm"})),
        js(job(status="running")),
        js(job(status="done", result={"success": True, "result": "42"})),
    )
    c = s.client(mode)
    assert resolve(c.tasks.wait("job_1", poll_interval=0.001))["question"]["id"] == "q1"
    assert resolve(c.tasks.wait("job_1", poll_interval=0.001, return_on_question=False))["result"]["result"] == "42"
    slow = scripted(js(job(status="running")))
    err = raises(lambda: slow.client(mode).tasks.wait("job_1", timeout=0))
    assert isinstance(err, WaitTimeoutError)
    assert err.code == "wait_timeout"
    assert not any(c.method == "DELETE" for c in slow.calls)


@pytest.mark.parametrize("mode", MODES)
def test_run_creates_then_waits(mode: str) -> None:
    s = scripted(js(job(), 201), js(job(status="done", result={"result": "ok"})))
    t = resolve(s.client(mode).tasks.run("go", startUrl="https://a.example", poll_interval=0))
    assert t["result"]["result"] == "ok"
    assert s.calls[0].body == {"task": "go", "startUrl": "https://a.example"}


@pytest.mark.parametrize("mode", MODES)
def test_answers_messages_follows_up_continues_and_cancels_with_the_apis_bodies(mode: str) -> None:
    ok = js({"ok": True})
    s = scripted(ok, ok, ok, ok, js(job(id="job_2"), 201), js(job(id="job_3"), 201), js(job(id="job_4"), 201), ok)
    c = s.client(mode)
    assert resolve(c.tasks.answer("job_1", "q1", "yes")) is None
    resolve(c.tasks.answer("job_1", "q2", "the blue one"))
    resolve(c.tasks.answer("job_1", "q3", {"type": "code", "code": "123"}))
    resolve(c.tasks.message("job_1", "use the cheaper one"))
    resolve(c.tasks.follow_up("job_1", {"text": "now the chair", "region": "us"}))
    resolve(c.tasks.follow_up("job_1", "and a table", region="in"))
    resolve(c.tasks.continue_("job_1"))
    resolve(c.tasks.cancel("job_1"))
    assert [f"{x.method} {x.url.path}" for x in s.calls] == [
        "POST /jobs/job_1/answer",
        "POST /jobs/job_1/answer",
        "POST /jobs/job_1/answer",
        "POST /jobs/job_1/message",
        "POST /jobs/job_1/followup",
        "POST /jobs/job_1/followup",
        "POST /jobs/job_1/followup",
        "DELETE /jobs/job_1",
    ]
    assert [x.body for x in s.calls] == [
        {"questionId": "q1", "answer": {"type": "yes"}},
        {"questionId": "q2", "answer": {"type": "text", "text": "the blue one"}},
        {"questionId": "q3", "answer": {"type": "code", "code": "123"}},
        {"text": "use the cheaper one"},
        {"text": "now the chair", "region": "us"},
        {"text": "and a table", "region": "in"},
        {"text": "Continue the task from where you left off."},
        None,
    ]
    assert pilotfish.CONTINUE_TEXT == "Continue the task from where you left off."


@pytest.mark.parametrize("mode", MODES)
def test_streams_each_event_once_asking_only_for_what_is_new_until_the_task_ends(mode: str) -> None:
    def e(seq: int) -> Dict[str, Any]:
        return {"seq": seq, "at": seq, "type": f"e{seq}", "data": {}}

    s = scripted(js(job(status="running")), js({"events": [e(1), e(2)]}), js(job(status="done")), js({"events": [e(3)]}), js({"events": []}))
    seen = [ev["type"] for ev in collect(s.client(mode).tasks.stream("job_1", poll_interval=0.001))]
    assert seen == ["e1", "e2", "e3"]
    assert [c.url.params.get("after") for c in s.calls if c.url.path.endswith("/events")] == [None, "2", "3"]


@pytest.mark.parametrize("mode", MODES)
def test_pages_through_tasks_by_cursor_and_runs_a_batch_to_its_end(mode: str) -> None:
    s = scripted(js({"jobs": [job(id="a")], "nextCursor": "c1"}), js({"jobs": [job(id="b")], "nextCursor": None}))
    ids = [t["id"] for t in collect(s.client(mode).tasks.iterate(limit=1))]
    assert ids == ["a", "b"]
    assert s.calls[1].url.params.get("cursor") == "c1"
    assert s.calls[0].url.params.get("mine") == "1"
    assert s.calls[0].url.params.get("limit") == "1"
    assert "status" not in s.calls[0].url.params

    def batch(status: str) -> Dict[str, Any]:
        return {"id": "bat_1", "name": None, "status": status, "counts": {"total": 2}, "costUsd": 0, "project": "default", "createdAt": 1, "updatedAt": 1, "finishedAt": None, "url": "u"}

    b = scripted(js(batch("running"), 201), js(batch("running")), js(batch("done")))
    assert resolve(b.client(mode).batches.run(["a", {"task": "b", "region": "us"}], poll_interval=0.001))["status"] == "done"
    assert b.calls[0].body == {"tasks": ["a", {"task": "b", "region": "us"}]}
    named = scripted(js(batch("running"), 201))
    resolve(named.client(mode).batches.create({"tasks": ["a"], "name": "n"}, webhookUrl="https://h.example"))
    assert named.calls[0].body == {"tasks": ["a"], "name": "n", "webhookUrl": "https://h.example"}
    slow = scripted(js(batch("running")))
    assert isinstance(raises(lambda: slow.client(mode).batches.wait("bat_1", timeout=0)), WaitTimeoutError)


@pytest.mark.parametrize("mode", MODES)
def test_lists_return_pages(mode: str) -> None:
    s = scripted(js({"identities": [{"id": "idn_1"}], "nextCursor": None, "total": 1}), js({"batches": [], "nextCursor": "x"}))
    c = s.client(mode)
    page = resolve(c.identities.list(external_user_id="user-42"))
    assert [i["id"] for i in page] == ["idn_1"]
    assert (page.next_cursor, page.total, len(page)) == (None, 1, 1)
    assert s.calls[0].url.params.get("externalUserId") == "user-42"
    bp = resolve(c.batches.list(status="done"))
    assert bp.items == [] and bp.next_cursor == "x"
    assert s.calls[1].url.params.get("status") == "done"


@pytest.mark.parametrize("mode", MODES)
def test_downloads_a_file_with_its_name_and_type(mode: str) -> None:
    s = scripted(
        raw(b"\x01\x02\x03", headers={"content-type": "application/pdf", "content-disposition": "attachment; filename=\"r_sum_.pdf\"; filename*=UTF-8''r%C3%A9sum%C3%A9.pdf"}),
        raw(b"x", headers={"content-type": "text/plain", "content-disposition": 'attachment; filename="plain.txt"'}),
        raw(b"v", headers={"content-type": "video/mp4"}),
    )
    c = s.client(mode)
    f = resolve(c.tasks.download_file("job_1", "file_1"))
    assert f.data == b"\x01\x02\x03"
    assert (f.content_type, f.filename) == ("application/pdf", "résumé.pdf")
    data, content_type, filename = f
    assert data == b"\x01\x02\x03"
    assert resolve(c.tasks.download_file("job_1", "file_2")).filename == "plain.txt"
    mp4 = resolve(c.tasks.replay_mp4("job_1"))
    assert (mp4.filename, mp4.content_type) == (None, "video/mp4")
    assert [x.url.path for x in s.calls] == ["/jobs/job_1/files/file_1", "/jobs/job_1/files/file_2", "/jobs/job_1/replay.mp4"]


@pytest.mark.parametrize("mode", MODES)
def test_follows_a_redirect_as_fetch_does(mode: str) -> None:
    def first(r: httpx.Request) -> httpx.Response:
        return httpx.Response(302, headers={"location": "https://files.example/replay.mp4?sig=1"})

    s = scripted(first, raw(b"mp4", headers={"content-type": "video/mp4"}))
    assert resolve(s.client(mode).tasks.replay_mp4("job_1")).data == b"mp4"
    assert str(s.calls[1].url) == "https://files.example/replay.mp4?sig=1"
    # httpx drops the key on a redirect to another origin.
    assert "authorization" not in s.calls[1].headers


@pytest.mark.parametrize("mode", MODES)
def test_usage_and_request(mode: str) -> None:
    s = scripted(js({"totalUsd": 1}), js({"secret": "whsec"}), raw(b"", 204))
    c = s.client(mode)
    assert resolve(c.usage.get(days=7, from_="2026-01-01", to="2026-01-31")) == {"totalUsd": 1}
    assert dict(s.calls[0].url.params) == {"days": "7", "from": "2026-01-01", "to": "2026-01-31"}
    assert resolve(c.request("GET", "/org/webhook-secret")) == {"secret": "whsec"}
    assert resolve(c.request("delete", "/x")) is None
    assert s.calls[2].method == "DELETE"


def test_context_managers_close_their_own_client() -> None:
    with Pilotfish(api_key="k") as pf:
        inner = pf._http
    assert inner.is_closed
    mine = httpx.Client(transport=httpx.MockTransport(lambda r: httpx.Response(200)))
    with Pilotfish(api_key="k", http_client=mine):
        pass
    assert not mine.is_closed

    async def go() -> httpx.AsyncClient:
        async with AsyncPilotfish(api_key="k") as apf:
            return apf._http

    assert asyncio.run(go()).is_closed


# ------------------------------------------------------------------------------------------------- sync/async parity

SYNC_RESOURCES = {"tasks": client_mod.Tasks, "batches": client_mod.Batches, "identities": client_mod.Identities, "saved_tasks": client_mod.SavedTasks, "schedules": client_mod.Schedules, "usage": client_mod.UsageApi}
ASYNC_RESOURCES = {"tasks": client_mod.AsyncTasks, "batches": client_mod.AsyncBatches, "identities": client_mod.AsyncIdentities, "saved_tasks": client_mod.AsyncSavedTasks, "schedules": client_mod.AsyncSchedules, "usage": client_mod.AsyncUsageApi}


def public(cls: type) -> Dict[str, inspect.Signature]:
    return {n: inspect.signature(f) for n, f in vars(cls).items() if callable(f) and not n.startswith("_")}


@pytest.mark.parametrize("name", list(SYNC_RESOURCES))
def test_the_async_client_has_the_same_methods_and_signatures(name: str) -> None:
    sync, asy = public(SYNC_RESOURCES[name]), public(ASYNC_RESOURCES[name])
    assert sorted(sync) == sorted(asy)
    for m in sync:
        assert [(p.name, p.kind, p.default) for p in sync[m].parameters.values()] == [(p.name, p.kind, p.default) for p in asy[m].parameters.values()], m
        is_gen = inspect.isgeneratorfunction(getattr(SYNC_RESOURCES[name], m))
        a = getattr(ASYNC_RESOURCES[name], m)
        assert inspect.isasyncgenfunction(a) if is_gen else inspect.iscoroutinefunction(a), m
    assert [n for n in vars(Pilotfish) if not n.startswith("_")] == [n for n in vars(AsyncPilotfish) if not n.startswith("_")]


# Every endpoint, with the answer it gets: the sync and async clients must send the very same requests.
ENDPOINTS: List[tuple] = [
    ("tasks", "create", ("t",), {"region": "us"}, job()),
    ("tasks", "get", ("job_1",), {}, job()),
    ("tasks", "list", (), {"status": "done", "limit": 2, "cursor": "c", "project": "p", "identity": "i"}, {"jobs": [], "nextCursor": None}),
    ("tasks", "events", ("job_1",), {"after": 4}, {"events": []}),
    ("tasks", "follow_up", ("job_1", "next"), {}, job()),
    ("tasks", "continue_", ("job_1",), {}, job()),
    ("tasks", "answer", ("job_1", "q", "no"), {}, {"ok": True}),
    ("tasks", "message", ("job_1", "hi"), {}, {"ok": True}),
    ("tasks", "cancel", ("job_1",), {}, {"ok": True}),
    ("tasks", "pause", ("job_1",), {}, {"ok": True, "control": "c"}),
    ("tasks", "resume", ("job_1",), {}, {"ok": True, "control": "c"}),
    ("tasks", "rerun", ("job_1",), {}, job()),
    ("tasks", "thread", ("job_1",), {}, {"threadId": "job_1", "jobs": [], "files": []}),
    ("tasks", "files", ("job_1",), {"offset": 1, "limit": 2}, {"files": [], "total": 0}),
    ("tasks", "frames", ("job_1",), {}, {"frames": []}),
    ("tasks", "delete_session", ("job_1",), {}, {"ok": True}),
    ("batches", "create", (["a", "b"],), {"name": "n"}, {"id": "bat_1"}),
    ("batches", "get", ("bat_1",), {}, {"id": "bat_1", "status": "done"}),
    ("batches", "list", (), {"status": "done", "limit": 1, "cursor": "c"}, {"batches": [], "nextCursor": None}),
    ("batches", "cancel", ("bat_1",), {}, {"id": "bat_1"}),
    ("identities", "create", ({"externalUserId": "u"},), {"label": "Ada"}, {"id": "idn_1"}),
    ("identities", "get", ("idn_1",), {}, {"id": "idn_1"}),
    ("identities", "list", (), {"external_user_id": "u", "q": "a", "limit": 3, "cursor": "c"}, {"identities": [], "nextCursor": None, "total": 0}),
    ("identities", "update", ("idn_1",), {"label": "B"}, {"id": "idn_1"}),
    ("identities", "delete", ("idn_1",), {}, {"ok": True}),
    ("identities", "usage", ("idn_1",), {"since": 1700000000000}, {}),
    ("identities", "add_credential", ("idn_1",), {"site": "example.com", "username": "u", "password": "p"}, {"credential": "cred_1"}),
    ("identities", "credentials", ("idn_1",), {}, {"credentials": []}),
    ("identities", "set_default_credential", ("idn_1", "cred_1"), {}, {"ok": True}),
    ("identities", "delete_credential", ("idn_1", "cred_1"), {}, {"ok": True}),
    ("identities", "login_link", ("idn_1", ["example.com"]), {"ttlMinutes": 30}, {"url": "u"}),
    ("saved_tasks", "list", (), {}, {"tasks": []}),
    ("saved_tasks", "create", (), {"name": "n", "task": "t", "options": {"startUrl": "https://a"}}, {"id": "st_1"}),
    ("saved_tasks", "update", ("st_1",), {"name": "m"}, {"id": "st_1"}),
    ("saved_tasks", "delete", ("st_1",), {}, {"ok": True}),
    ("saved_tasks", "run", ("st_1",), {"extraInstructions": "x"}, job()),
    ("schedules", "list", (), {}, {"schedules": []}),
    ("schedules", "create", (), {"savedTaskId": "st_1", "rule": {"repeat": "daily", "time": "09:00", "tz": "UTC"}}, {"savedTaskId": "st_1"}),
    ("schedules", "update", ("st_1",), {"paused": True}, {"savedTaskId": "st_1"}),
    ("schedules", "delete", ("st_1",), {}, {"ok": True}),
    ("usage", "get", (), {"days": 7}, {}),
]

EXPECTED = {
    ("tasks", "create"): ("POST", "/jobs", {"task": "t", "region": "us"}),
    ("tasks", "list"): ("GET", "/jobs?mine=1&status=done&limit=2&cursor=c&project=p&identity=i", None),
    ("tasks", "events"): ("GET", "/jobs/job_1/events?after=4", None),
    ("tasks", "delete_session"): ("DELETE", "/jobs/job_1/history", None),
    ("identities", "update"): ("PATCH", "/identities/idn_1", {"label": "B"}),
    ("identities", "usage"): ("GET", "/identities/idn_1/usage?since=1700000000000", None),
    ("identities", "set_default_credential"): ("PUT", "/identities/idn_1/credentials/cred_1/default", None),
    ("identities", "login_link"): ("POST", "/identities/idn_1/link", {"sites": ["example.com"], "ttlMinutes": 30}),
    ("saved_tasks", "update"): ("PUT", "/saved-tasks/st_1", {"name": "m"}),
    ("schedules", "update"): ("PUT", "/schedules/st_1", {"paused": True}),
    ("batches", "create"): ("POST", "/batches", {"tasks": ["a", "b"], "name": "n"}),
    ("batches", "cancel"): ("POST", "/batches/bat_1/cancel", None),
}


@pytest.mark.parametrize("resource,method,args,kwargs,answer", ENDPOINTS, ids=[f"{e[0]}.{e[1]}" for e in ENDPOINTS])
def test_sync_and_async_send_the_same_request(resource: str, method: str, args: tuple, kwargs: dict, answer: Any) -> None:
    seen = []
    for mode in MODES:
        s = scripted(js(answer))
        resolve(getattr(getattr(s.client(mode), resource), method)(*args, **kwargs))
        c = s.calls[0]
        seen.append((c.method, c.url.raw_path.decode(), c.body))
    assert seen[0] == seen[1]
    if (resource, method) in EXPECTED:
        assert seen[0] == EXPECTED[(resource, method)]


@pytest.mark.parametrize("mode", MODES)
def test_sign_in_question_ways_read_from_a_task(mode: str) -> None:
    question = {"id": "q1", "kind": "live_view", "category": "login", "message": "Please sign in to food.example", "signIn": {"ways": ["phone_code", "password"], "providers": ["Google"], "opensOn": "phone_code", "pageWords": "Login"}}
    s = scripted(js(job(status="needs_input", question=question)))
    t = resolve(s.client(mode).tasks.get("job_1"))
    assert pilotfish.sign_in_of(t["question"]) == {"ways": ["phone_code", "password"], "providers": ["Google"], "opensOn": "phone_code", "pageWords": "Login", "unclear": False}
    assert pilotfish.SIGN_IN_WAYS == ("password", "phone_code", "email_code", "identifier_first", "passkey")


def test_sign_in_of_checks_the_field_as_the_typescript_sdk_does() -> None:
    q = lambda s: {"id": "q1", "category": "login", "signIn": s}  # noqa: E731
    assert pilotfish.sign_in_of(q({"ways": ["password", "magic_wand", "password"], "providers": ["Apple", ""], "opensOn": "phone_code", "asked": "password"})) == {"ways": ["password"], "providers": ["Apple"], "unclear": False}
    assert pilotfish.sign_in_of(q({"ways": ["passkey"], "providers": [], "opensOn": "passkey", "asked": "email_code"})) == {"ways": ["passkey"], "providers": [], "asked": "email_code", "unclear": False}
    assert pilotfish.sign_in_of(q({"ways": [], "providers": [], "pageWords": "Members area"})) == {"ways": [], "providers": [], "pageWords": "Members area", "unclear": True}
    assert pilotfish.sign_in_of(q("password")) is None
    assert pilotfish.sign_in_of({"id": "q2", "category": "captcha", "signIn": {"ways": ["password"], "providers": []}}) is None
    assert pilotfish.sign_in_of(None) is None
