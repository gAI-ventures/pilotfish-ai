"""The hosted client: pilotfish's REST API (https://pilotfish.gai.ventures/docs/api) with an API key from Org settings →
API keys. Tasks run in pilotfish's cloud browser and are paid from your org's credits.

``Pilotfish`` is synchronous (httpx.Client); ``AsyncPilotfish`` has the same surface for asyncio (httpx.AsyncClient).
Both return the API's JSON as plain dicts, with the API's own (camelCase) field names. Request bodies take the API's
names too, as a dict or as keyword arguments: ``pf.tasks.create("find the lamp", startUrl="https://...", maxSteps=20)``.
Query options are snake_case keyword arguments: ``pf.tasks.list(status="done", limit=10)``.
"""

from __future__ import annotations

import asyncio
import time
from typing import Any, AsyncIterator, Dict, Iterator, List, Mapping, Optional, Sequence, Union

import httpx

from . import _core
from ._core import CONTINUE_TEXT, DEFAULT_BASE_URL, DownloadedFile, Page, enc
from .errors import ConnectionError, WaitTimeoutError
from .types import (
    Batch,
    Frame,
    Identity,
    IdentityLogin,
    LoginLink,
    SavedTask,
    Schedule,
    SessionFile,
    Task,
    TaskEvent,
    Usage,
)

__all__ = [
    "Pilotfish",
    "AsyncPilotfish",
    "Tasks",
    "Batches",
    "Identities",
    "SavedTasks",
    "Schedules",
    "UsageApi",
    "AsyncTasks",
    "AsyncBatches",
    "AsyncIdentities",
    "AsyncSavedTasks",
    "AsyncSchedules",
    "AsyncUsageApi",
    "Page",
    "DownloadedFile",
    "DEFAULT_BASE_URL",
    "CONTINUE_TEXT",
]

TaskInput = Union[str, Mapping[str, Any]]
BatchInput = Union[Sequence[Union[str, Mapping[str, Any]]], Mapping[str, Any]]
AnswerInput = Union[str, Mapping[str, Any]]
Query = Mapping[str, Union[str, int, float, bool, None]]

# Looked up at call time, so tests can make waiting instant.
_sleep = time.sleep
_asleep = asyncio.sleep
_monotonic = time.monotonic


def _deadline(timeout: Optional[float]) -> Optional[float]:
    return None if timeout is None else _monotonic() + timeout


def _past(until: Optional[float]) -> bool:
    return until is not None and _monotonic() >= until


# =================================================================================================== sync


class Pilotfish:
    """The hosted client.

    Args:
        api_key: An API key (``pf_...``, Org settings → API keys). Default: the ``PILOTFISH_API_KEY`` environment variable.
        base_url: Default: ``PILOTFISH_BASE_URL``, else https://pilotfish-be.gai.ventures.
        max_retries: Tries after the first for a 429 (after its ``retryAfterS``), a 5xx or a network failure on a read.
        timeout: Per-request timeout, seconds.
        http_client: Your own ``httpx.Client`` (proxies, tests). It is not closed by ``close()``.
    """

    def __init__(
        self,
        api_key: Optional[str] = None,
        base_url: Optional[str] = None,
        max_retries: int = 2,
        timeout: float = 60.0,
        http_client: Optional[httpx.Client] = None,
    ) -> None:
        self._api_key, self.base_url = _core.resolve(api_key, base_url)
        self.max_retries = max_retries
        self.timeout = timeout
        self._own_http = http_client is None
        self._http = http_client if http_client is not None else httpx.Client()
        self.tasks = Tasks(self)
        self.batches = Batches(self)
        self.identities = Identities(self)
        self.saved_tasks = SavedTasks(self)
        self.schedules = Schedules(self)
        self.usage = UsageApi(self)

    def request(self, method: str, path: str, body: Any = None, query: Optional[Query] = None) -> Any:
        """One API call: JSON in and out, typed errors, retries on 429 (after its ``retryAfterS``) and, for reads, on
        5xx and network failures. Returns the response's JSON (None for an empty answer)."""
        res = self._send(method, path, body, query)
        return _core.decode(res.status_code, res.content)

    def download(self, path: str) -> DownloadedFile:
        """The raw response of a call that returns a file: its bytes, type and name."""
        res = self._send("GET", path, None, None)
        return DownloadedFile(res.content, res.headers.get("content-type", "application/octet-stream"), _core.filename_of(res.headers.get("content-disposition")))

    def _send(self, method: str, path: str, body: Any, query: Optional[Query]) -> httpx.Response:
        method = method.upper()
        read = _core.is_read(method)
        content = _core.encode_body(body)
        hdrs = _core.headers(self._api_key, content is not None)
        params = _core.query_params(query)
        attempt = 0
        while True:
            try:
                res = self._http.request(method, self.base_url + path, params=params, content=content, headers=hdrs, timeout=self.timeout, follow_redirects=True)
            except httpx.TransportError as e:
                delay = _core.network_retry_delay(read, attempt, self.max_retries)
                if delay is None:
                    raise ConnectionError(f"{method} {path}: {e}", e) from e
                _sleep(delay)
                attempt += 1
                continue
            o = _core.outcome(res.status_code, res.headers.get("retry-after"), res.content, read, attempt, self.max_retries)
            if o.action == "ok":
                return res
            if o.action == "retry":
                _sleep(o.delay)
                attempt += 1
                continue
            assert o.error is not None
            raise o.error

    def close(self) -> None:
        """Close the HTTP client (unless it was your own)."""
        if self._own_http:
            self._http.close()

    def __enter__(self) -> "Pilotfish":
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()


class Tasks:
    """Tasks (the API's jobs): run, watch, answer, steer, follow up, and read their files and replays."""

    def __init__(self, client: Pilotfish) -> None:
        self._c = client

    def create(self, task: TaskInput, **fields: Any) -> Task:
        """Start a task; returns at once with its id (and ``url``, ``appUrl``, ``answerUrl``). ``task`` is its words or
        a whole request (``{"task", "startUrl", "maxSteps", "outputSchema", ...}``); keyword fields are added to it."""
        return self._c.request("POST", "/jobs", _core.body(task, fields, "task"))

    def run(self, task: TaskInput, *, timeout: Optional[float] = 1800.0, poll_interval: float = 2.0, return_on_question: bool = True, **fields: Any) -> Task:
        """Start a task and wait for it to end (or to wait on a question, unless ``return_on_question=False``)."""
        t = self.create(task, **fields)
        return self.wait(t["id"], timeout=timeout, poll_interval=poll_interval, return_on_question=return_on_question)

    def get(self, id: str) -> Task:
        """A task with its result, question, settings, cost so far and live view."""
        return self._c.request("GET", f"/jobs/{enc(id)}")

    def wait(self, id: str, *, timeout: Optional[float] = 1800.0, poll_interval: float = 2.0, return_on_question: bool = True) -> Task:
        """Wait until the task ends, or waits on a question (unless ``return_on_question=False``). Raises
        WaitTimeoutError after ``timeout`` seconds (default 30 min; None waits for ever); the task carries on."""
        until = _deadline(timeout)
        while True:
            t = self.get(id)
            if _core.wait_returns(t, return_on_question):
                return t
            if _past(until):
                raise WaitTimeoutError(f"Task {id} is still {t.get('status')}: it carries on; wait again or cancel it.")
            _sleep(poll_interval)

    def list(self, *, status: Optional[str] = None, limit: Optional[int] = None, cursor: Optional[str] = None, project: Optional[str] = None, identity: Optional[str] = None) -> Page[Task]:
        """Your tasks, newest first (a key: the tasks it started). One page; ``iterate`` walks them all."""
        r = self._c.request("GET", "/jobs", query={"mine": 1, "status": status, "limit": limit, "cursor": cursor, "project": project, "identity": identity})
        return Page(r["jobs"], r.get("nextCursor"))

    def iterate(self, *, status: Optional[str] = None, limit: Optional[int] = None, project: Optional[str] = None, identity: Optional[str] = None) -> Iterator[Task]:
        """Every task, page after page."""
        cursor: Optional[str] = None
        while True:
            page = self.list(status=status, limit=limit, cursor=cursor, project=project, identity=identity)
            yield from page.items
            cursor = page.next_cursor
            if not cursor:
                return

    def events(self, id: str, after: Optional[int] = None) -> List[TaskEvent]:
        """The task's events (steps, questions, files...), or those after ``after`` (an event's ``seq``)."""
        return self._c.request("GET", f"/jobs/{enc(id)}/events", query={"after": after})["events"]

    def stream(self, id: str, *, poll_interval: float = 1.0) -> Iterator[TaskEvent]:
        """Each new event as it happens, until the task ends."""
        after = -1
        while True:
            t = self.get(id)
            for e in self.events(id, after if after >= 0 else None):
                after = _core.seq_of(e, after)
                yield e
            if t.get("status") in _core.ENDED:
                yield from self.events(id, after if after >= 0 else None)
                return
            _sleep(poll_interval)

    def follow_up(self, id: str, request: TaskInput, **fields: Any) -> Task:
        """The next instruction in the same session: the same browser while it is kept, the same sign-ins, what earlier
        turns found. ``request`` is its text or a whole follow-up (``{"text", "region", "outputSchema", ...}``)."""
        return self._c.request("POST", f"/jobs/{enc(id)}/followup", _core.body(request, fields, "text"))

    def continue_(self, id: str) -> Task:
        """Carry a paused task on (``paused: True``, ``next: "continue"``), as the app's Continue does. (Named with a
        trailing underscore since ``continue`` is a Python keyword.)"""
        return self.follow_up(id, CONTINUE_TEXT)

    def answer(self, id: str, question_id: str, answer: AnswerInput) -> None:
        """Answer the task's open question (``task["question"]["id"]``): ``"yes"``, ``"no"``, ``"done"``, ``"cancel"``,
        any other text, or an answer dict (``{"type": "code", "code": ...}``). Codes and passwords go on its
        ``answerUrl``, never here."""
        self._c.request("POST", f"/jobs/{enc(id)}/answer", _core.answer_body(question_id, answer))

    def message(self, id: str, text: str) -> None:
        """Tell a running task something in the person's words; it reads it before its next step."""
        self._c.request("POST", f"/jobs/{enc(id)}/message", {"text": text})

    def cancel(self, id: str) -> None:
        """Stop a task for good (what it spent stays charged)."""
        self._c.request("DELETE", f"/jobs/{enc(id)}")

    def pause(self, id: str) -> Dict[str, Any]:
        """Take control: the agent stops at its next turn and the browser is the person's (the live view's control token)."""
        return self._c.request("POST", f"/jobs/{enc(id)}/pause")

    def resume(self, id: str) -> Dict[str, Any]:
        """Hand the browser back: the agent carries on from where the person left it."""
        return self._c.request("POST", f"/jobs/{enc(id)}/resume")

    def rerun(self, id: str) -> Task:
        """The same task again with the same settings, as a new task in a new session."""
        return self._c.request("POST", f"/jobs/{enc(id)}/rerun")

    def thread(self, id: str) -> Dict[str, Any]:
        """The task's whole session: ``threadId``, its turns (``jobs``, each with its ``events``), its ``files``, and the
        browser ``kept`` for a follow-up."""
        return self._c.request("GET", f"/jobs/{enc(id)}/thread")

    def files(self, id: str, *, offset: Optional[int] = None, limit: Optional[int] = None) -> Dict[str, Any]:
        """The session's files (attached, downloaded by the run, or PDFs it read): ``{"files": [...], "total": n}``."""
        return self._c.request("GET", f"/jobs/{enc(id)}/files", query={"offset": offset, "limit": limit})

    def download_file(self, id: str, file_id: str) -> DownloadedFile:
        """One file's bytes, with its type and name: ``data, content_type, filename = pf.tasks.download_file(...)``."""
        return self._c.download(f"/jobs/{enc(id)}/files/{enc(file_id)}")

    def frames(self, id: str) -> List[Frame]:
        """The screenshots taken after the steps that changed the page."""
        return self._c.request("GET", f"/jobs/{enc(id)}/frames")["frames"]

    def replay_mp4(self, id: str) -> DownloadedFile:
        """The replay video (MP4), while it is kept (7 days by default)."""
        return self._c.download(f"/jobs/{enc(id)}/replay.mp4")

    def delete_session(self, id: str) -> None:
        """Delete the task's session from history (soft: its record and cost are kept for billing)."""
        self._c.request("DELETE", f"/jobs/{enc(id)}/history")


class Batches:
    """Batches: many tasks in one request, run one after another, their results collected together."""

    def __init__(self, client: Pilotfish) -> None:
        self._c = client

    def create(self, request: BatchInput, **fields: Any) -> Batch:
        """Start a batch (up to 100 tasks): a list of tasks (each its words or a whole task request), or a whole batch
        request (``{"tasks", "defaults", "name", "webhookUrl"}``). Each task is charged when it runs; if credits run out
        the rest are skipped."""
        return self._c.request("POST", "/batches", _core.body(request, fields, "tasks"))

    def run(self, request: BatchInput, *, timeout: Optional[float] = 7200.0, poll_interval: float = 3.0, **fields: Any) -> Batch:
        """Start a batch and wait for every task to end."""
        b = self.create(request, **fields)
        return self.wait(b["id"], timeout=timeout, poll_interval=poll_interval)

    def get(self, id: str) -> Batch:
        """A batch with each task's status, job id, cost and result."""
        return self._c.request("GET", f"/batches/{enc(id)}")

    def wait(self, id: str, *, timeout: Optional[float] = 7200.0, poll_interval: float = 3.0) -> Batch:
        """Wait until the batch ends (done, cancelled or stopped). Raises WaitTimeoutError after ``timeout`` seconds
        (default 2 h)."""
        until = _deadline(timeout)
        while True:
            b = self.get(id)
            if b.get("status") != "running":
                return b
            if _past(until):
                raise WaitTimeoutError(f"Batch {id} is still running: it carries on; wait again or cancel it.")
            _sleep(poll_interval)

    def list(self, *, status: Optional[str] = None, limit: Optional[int] = None, cursor: Optional[str] = None) -> Page[Batch]:
        """Your batches, newest first (without their items)."""
        r = self._c.request("GET", "/batches", query={"status": status, "limit": limit, "cursor": cursor})
        return Page(r["batches"], r.get("nextCursor"))

    def cancel(self, id: str) -> Batch:
        """Cancel: the running task is cancelled and the rest are skipped (never run, never charged)."""
        return self._c.request("POST", f"/batches/{enc(id)}/cancel")


class Identities:
    """Identities: your product's end users in a shared project (an org key's project), each with their own logins,
    sessions, IP and device."""

    def __init__(self, client: Pilotfish) -> None:
        self._c = client

    def create(self, identity: Optional[Mapping[str, Any]] = None, **fields: Any) -> Identity:
        """Make one (``label``, ``externalUserId``, ``country``, ``deviceOs``, ``email``, ``saveLogins``); with an
        ``externalUserId`` you already used, you get that one back (``existed: True``)."""
        return self._c.request("POST", "/identities", _core.body(identity, fields))

    def get(self, id: str) -> Identity:
        return self._c.request("GET", f"/identities/{enc(id)}")

    def list(self, *, external_user_id: Optional[str] = None, q: Optional[str] = None, limit: Optional[int] = None, cursor: Optional[str] = None) -> Page[Identity]:
        """One page of identities, with ``total``."""
        r = self._c.request("GET", "/identities", query={"externalUserId": external_user_id, "q": q, "limit": limit, "cursor": cursor})
        return Page(r["identities"], r.get("nextCursor"), r.get("total"))

    def update(self, id: str, changes: Optional[Mapping[str, Any]] = None, **fields: Any) -> Identity:
        return self._c.request("PATCH", f"/identities/{enc(id)}", _core.body(changes, fields))

    def delete(self, id: str) -> None:
        """Wipes its logins, sessions and device; its tasks and their cost are kept."""
        self._c.request("DELETE", f"/identities/{enc(id)}")

    def usage(self, id: str, *, since: Optional[int] = None) -> Usage:
        """Its spending, from ``since`` (ms since the epoch) on."""
        return self._c.request("GET", f"/identities/{enc(id)}/usage", query={"since": since})

    def add_credential(self, id: str, credential: Optional[Mapping[str, Any]] = None, **fields: Any) -> Dict[str, Any]:
        """Save a login for it from your own server (``site``, ``username``, ``password``, ``totp``, ``otp``,
        ``account``, ``default``): the values are sealed and never read back. Returns ``{"credential": "cred_...", ...}``."""
        return self._c.request("POST", f"/identities/{enc(id)}/credentials", _core.body(credential, fields))

    def credentials(self, id: str) -> List[IdentityLogin]:
        """Its saved logins, masked."""
        return self._c.request("GET", f"/identities/{enc(id)}/credentials")["credentials"]

    def set_default_credential(self, id: str, credential: str) -> None:
        self._c.request("PUT", f"/identities/{enc(id)}/credentials/{enc(credential)}/default")

    def delete_credential(self, id: str, credential: str) -> None:
        self._c.request("DELETE", f"/identities/{enc(id)}/credentials/{enc(credential)}")

    def login_link(self, id: str, sites: Sequence[str], **fields: Any) -> LoginLink:
        """A one-time page where the end user types their own login for these sites (further fields: ``account``,
        ``ttlMinutes``, ``webhookUrl``)."""
        return self._c.request("POST", f"/identities/{enc(id)}/link", {"sites": list(sites), **fields})


class SavedTasks:
    """Saved tasks (in your Personal project): run again with their settings, by hand or on a schedule."""

    def __init__(self, client: Pilotfish) -> None:
        self._c = client

    def list(self) -> List[SavedTask]:
        return self._c.request("GET", "/saved-tasks")["tasks"]

    def create(self, saved: Optional[Mapping[str, Any]] = None, **fields: Any) -> SavedTask:
        """Save a task: ``name``, ``task``, ``options`` (its settings), ``fromJob``."""
        return self._c.request("POST", "/saved-tasks", _core.body(saved, fields))

    def update(self, id: str, changes: Optional[Mapping[str, Any]] = None, **fields: Any) -> SavedTask:
        return self._c.request("PUT", f"/saved-tasks/{enc(id)}", _core.body(changes, fields))

    def delete(self, id: str) -> None:
        self._c.request("DELETE", f"/saved-tasks/{enc(id)}")

    def run(self, id: str, changes: Optional[Mapping[str, Any]] = None, **fields: Any) -> Task:
        """Run it, with changes for this run only (``extraInstructions``, ``startUrl``, ``region``, ``sites``,
        ``solve``, ``outputSchema``, and the other settings the API takes)."""
        return self._c.request("POST", f"/saved-tasks/{enc(id)}/run", _core.body(changes, fields))


class Schedules:
    """Schedules: a saved task run by itself. What would stop a run with nobody there is settled first (409 ``not_ready``)."""

    def __init__(self, client: Pilotfish) -> None:
        self._c = client

    def list(self) -> List[Schedule]:
        return self._c.request("GET", "/schedules")["schedules"]

    def create(self, schedule: Optional[Mapping[str, Any]] = None, **fields: Any) -> Schedule:
        """Schedule a saved task (``rule``, ``savedTaskId``), or a new task saved with it (``rule``, ``task``, ``name``,
        ``options``); ``paused`` too."""
        return self._c.request("POST", "/schedules", _core.body(schedule, fields))

    def update(self, saved_task_id: str, changes: Optional[Mapping[str, Any]] = None, **fields: Any) -> Schedule:
        return self._c.request("PUT", f"/schedules/{enc(saved_task_id)}", _core.body(changes, fields))

    def delete(self, saved_task_id: str) -> None:
        self._c.request("DELETE", f"/schedules/{enc(saved_task_id)}")


class UsageApi:
    """Spending: yours (a key: its own), by kind, day, model and task, and what is left of an allowance."""

    def __init__(self, client: Pilotfish) -> None:
        self._c = client

    def get(self, *, days: Optional[int] = None, from_: Optional[str] = None, to: Optional[str] = None) -> Usage:
        """The last ``days`` (default 30), or ``from_``/``to`` (YYYY-MM-DD)."""
        return self._c.request("GET", "/me/usage", query={"days": days, "from": from_, "to": to})


# =================================================================================================== async


class AsyncPilotfish:
    """The hosted client for asyncio: the same surface as ``Pilotfish``, every call awaited, and ``iterate`` and
    ``stream`` async iterators. ``http_client`` is your own ``httpx.AsyncClient``."""

    def __init__(
        self,
        api_key: Optional[str] = None,
        base_url: Optional[str] = None,
        max_retries: int = 2,
        timeout: float = 60.0,
        http_client: Optional[httpx.AsyncClient] = None,
    ) -> None:
        self._api_key, self.base_url = _core.resolve(api_key, base_url)
        self.max_retries = max_retries
        self.timeout = timeout
        self._own_http = http_client is None
        self._http = http_client if http_client is not None else httpx.AsyncClient()
        self.tasks = AsyncTasks(self)
        self.batches = AsyncBatches(self)
        self.identities = AsyncIdentities(self)
        self.saved_tasks = AsyncSavedTasks(self)
        self.schedules = AsyncSchedules(self)
        self.usage = AsyncUsageApi(self)

    async def request(self, method: str, path: str, body: Any = None, query: Optional[Query] = None) -> Any:
        """One API call (see ``Pilotfish.request``)."""
        res = await self._send(method, path, body, query)
        return _core.decode(res.status_code, res.content)

    async def download(self, path: str) -> DownloadedFile:
        res = await self._send("GET", path, None, None)
        return DownloadedFile(res.content, res.headers.get("content-type", "application/octet-stream"), _core.filename_of(res.headers.get("content-disposition")))

    async def _send(self, method: str, path: str, body: Any, query: Optional[Query]) -> httpx.Response:
        method = method.upper()
        read = _core.is_read(method)
        content = _core.encode_body(body)
        hdrs = _core.headers(self._api_key, content is not None)
        params = _core.query_params(query)
        attempt = 0
        while True:
            try:
                res = await self._http.request(method, self.base_url + path, params=params, content=content, headers=hdrs, timeout=self.timeout, follow_redirects=True)
            except httpx.TransportError as e:
                delay = _core.network_retry_delay(read, attempt, self.max_retries)
                if delay is None:
                    raise ConnectionError(f"{method} {path}: {e}", e) from e
                await _asleep(delay)
                attempt += 1
                continue
            o = _core.outcome(res.status_code, res.headers.get("retry-after"), res.content, read, attempt, self.max_retries)
            if o.action == "ok":
                return res
            if o.action == "retry":
                await _asleep(o.delay)
                attempt += 1
                continue
            assert o.error is not None
            raise o.error

    async def close(self) -> None:
        if self._own_http:
            await self._http.aclose()

    async def __aenter__(self) -> "AsyncPilotfish":
        return self

    async def __aexit__(self, *exc: Any) -> None:
        await self.close()


class AsyncTasks:
    """Tasks, awaited (see ``Tasks``)."""

    def __init__(self, client: AsyncPilotfish) -> None:
        self._c = client

    async def create(self, task: TaskInput, **fields: Any) -> Task:
        return await self._c.request("POST", "/jobs", _core.body(task, fields, "task"))

    async def run(self, task: TaskInput, *, timeout: Optional[float] = 1800.0, poll_interval: float = 2.0, return_on_question: bool = True, **fields: Any) -> Task:
        t = await self.create(task, **fields)
        return await self.wait(t["id"], timeout=timeout, poll_interval=poll_interval, return_on_question=return_on_question)

    async def get(self, id: str) -> Task:
        return await self._c.request("GET", f"/jobs/{enc(id)}")

    async def wait(self, id: str, *, timeout: Optional[float] = 1800.0, poll_interval: float = 2.0, return_on_question: bool = True) -> Task:
        until = _deadline(timeout)
        while True:
            t = await self.get(id)
            if _core.wait_returns(t, return_on_question):
                return t
            if _past(until):
                raise WaitTimeoutError(f"Task {id} is still {t.get('status')}: it carries on; wait again or cancel it.")
            await _asleep(poll_interval)

    async def list(self, *, status: Optional[str] = None, limit: Optional[int] = None, cursor: Optional[str] = None, project: Optional[str] = None, identity: Optional[str] = None) -> Page[Task]:
        r = await self._c.request("GET", "/jobs", query={"mine": 1, "status": status, "limit": limit, "cursor": cursor, "project": project, "identity": identity})
        return Page(r["jobs"], r.get("nextCursor"))

    async def iterate(self, *, status: Optional[str] = None, limit: Optional[int] = None, project: Optional[str] = None, identity: Optional[str] = None) -> AsyncIterator[Task]:
        cursor: Optional[str] = None
        while True:
            page = await self.list(status=status, limit=limit, cursor=cursor, project=project, identity=identity)
            for t in page.items:
                yield t
            cursor = page.next_cursor
            if not cursor:
                return

    async def events(self, id: str, after: Optional[int] = None) -> List[TaskEvent]:
        return (await self._c.request("GET", f"/jobs/{enc(id)}/events", query={"after": after}))["events"]

    async def stream(self, id: str, *, poll_interval: float = 1.0) -> AsyncIterator[TaskEvent]:
        after = -1
        while True:
            t = await self.get(id)
            for e in await self.events(id, after if after >= 0 else None):
                after = _core.seq_of(e, after)
                yield e
            if t.get("status") in _core.ENDED:
                for e in await self.events(id, after if after >= 0 else None):
                    yield e
                return
            await _asleep(poll_interval)

    async def follow_up(self, id: str, request: TaskInput, **fields: Any) -> Task:
        return await self._c.request("POST", f"/jobs/{enc(id)}/followup", _core.body(request, fields, "text"))

    async def continue_(self, id: str) -> Task:
        return await self.follow_up(id, CONTINUE_TEXT)

    async def answer(self, id: str, question_id: str, answer: AnswerInput) -> None:
        await self._c.request("POST", f"/jobs/{enc(id)}/answer", _core.answer_body(question_id, answer))

    async def message(self, id: str, text: str) -> None:
        await self._c.request("POST", f"/jobs/{enc(id)}/message", {"text": text})

    async def cancel(self, id: str) -> None:
        await self._c.request("DELETE", f"/jobs/{enc(id)}")

    async def pause(self, id: str) -> Dict[str, Any]:
        return await self._c.request("POST", f"/jobs/{enc(id)}/pause")

    async def resume(self, id: str) -> Dict[str, Any]:
        return await self._c.request("POST", f"/jobs/{enc(id)}/resume")

    async def rerun(self, id: str) -> Task:
        return await self._c.request("POST", f"/jobs/{enc(id)}/rerun")

    async def thread(self, id: str) -> Dict[str, Any]:
        return await self._c.request("GET", f"/jobs/{enc(id)}/thread")

    async def files(self, id: str, *, offset: Optional[int] = None, limit: Optional[int] = None) -> Dict[str, Any]:
        return await self._c.request("GET", f"/jobs/{enc(id)}/files", query={"offset": offset, "limit": limit})

    async def download_file(self, id: str, file_id: str) -> DownloadedFile:
        return await self._c.download(f"/jobs/{enc(id)}/files/{enc(file_id)}")

    async def frames(self, id: str) -> List[Frame]:
        return (await self._c.request("GET", f"/jobs/{enc(id)}/frames"))["frames"]

    async def replay_mp4(self, id: str) -> DownloadedFile:
        return await self._c.download(f"/jobs/{enc(id)}/replay.mp4")

    async def delete_session(self, id: str) -> None:
        await self._c.request("DELETE", f"/jobs/{enc(id)}/history")


class AsyncBatches:
    """Batches, awaited (see ``Batches``)."""

    def __init__(self, client: AsyncPilotfish) -> None:
        self._c = client

    async def create(self, request: BatchInput, **fields: Any) -> Batch:
        return await self._c.request("POST", "/batches", _core.body(request, fields, "tasks"))

    async def run(self, request: BatchInput, *, timeout: Optional[float] = 7200.0, poll_interval: float = 3.0, **fields: Any) -> Batch:
        b = await self.create(request, **fields)
        return await self.wait(b["id"], timeout=timeout, poll_interval=poll_interval)

    async def get(self, id: str) -> Batch:
        return await self._c.request("GET", f"/batches/{enc(id)}")

    async def wait(self, id: str, *, timeout: Optional[float] = 7200.0, poll_interval: float = 3.0) -> Batch:
        until = _deadline(timeout)
        while True:
            b = await self.get(id)
            if b.get("status") != "running":
                return b
            if _past(until):
                raise WaitTimeoutError(f"Batch {id} is still running: it carries on; wait again or cancel it.")
            await _asleep(poll_interval)

    async def list(self, *, status: Optional[str] = None, limit: Optional[int] = None, cursor: Optional[str] = None) -> Page[Batch]:
        r = await self._c.request("GET", "/batches", query={"status": status, "limit": limit, "cursor": cursor})
        return Page(r["batches"], r.get("nextCursor"))

    async def cancel(self, id: str) -> Batch:
        return await self._c.request("POST", f"/batches/{enc(id)}/cancel")


class AsyncIdentities:
    """Identities, awaited (see ``Identities``)."""

    def __init__(self, client: AsyncPilotfish) -> None:
        self._c = client

    async def create(self, identity: Optional[Mapping[str, Any]] = None, **fields: Any) -> Identity:
        return await self._c.request("POST", "/identities", _core.body(identity, fields))

    async def get(self, id: str) -> Identity:
        return await self._c.request("GET", f"/identities/{enc(id)}")

    async def list(self, *, external_user_id: Optional[str] = None, q: Optional[str] = None, limit: Optional[int] = None, cursor: Optional[str] = None) -> Page[Identity]:
        r = await self._c.request("GET", "/identities", query={"externalUserId": external_user_id, "q": q, "limit": limit, "cursor": cursor})
        return Page(r["identities"], r.get("nextCursor"), r.get("total"))

    async def update(self, id: str, changes: Optional[Mapping[str, Any]] = None, **fields: Any) -> Identity:
        return await self._c.request("PATCH", f"/identities/{enc(id)}", _core.body(changes, fields))

    async def delete(self, id: str) -> None:
        await self._c.request("DELETE", f"/identities/{enc(id)}")

    async def usage(self, id: str, *, since: Optional[int] = None) -> Usage:
        return await self._c.request("GET", f"/identities/{enc(id)}/usage", query={"since": since})

    async def add_credential(self, id: str, credential: Optional[Mapping[str, Any]] = None, **fields: Any) -> Dict[str, Any]:
        return await self._c.request("POST", f"/identities/{enc(id)}/credentials", _core.body(credential, fields))

    async def credentials(self, id: str) -> List[IdentityLogin]:
        return (await self._c.request("GET", f"/identities/{enc(id)}/credentials"))["credentials"]

    async def set_default_credential(self, id: str, credential: str) -> None:
        await self._c.request("PUT", f"/identities/{enc(id)}/credentials/{enc(credential)}/default")

    async def delete_credential(self, id: str, credential: str) -> None:
        await self._c.request("DELETE", f"/identities/{enc(id)}/credentials/{enc(credential)}")

    async def login_link(self, id: str, sites: Sequence[str], **fields: Any) -> LoginLink:
        return await self._c.request("POST", f"/identities/{enc(id)}/link", {"sites": list(sites), **fields})


class AsyncSavedTasks:
    """Saved tasks, awaited (see ``SavedTasks``)."""

    def __init__(self, client: AsyncPilotfish) -> None:
        self._c = client

    async def list(self) -> List[SavedTask]:
        return (await self._c.request("GET", "/saved-tasks"))["tasks"]

    async def create(self, saved: Optional[Mapping[str, Any]] = None, **fields: Any) -> SavedTask:
        return await self._c.request("POST", "/saved-tasks", _core.body(saved, fields))

    async def update(self, id: str, changes: Optional[Mapping[str, Any]] = None, **fields: Any) -> SavedTask:
        return await self._c.request("PUT", f"/saved-tasks/{enc(id)}", _core.body(changes, fields))

    async def delete(self, id: str) -> None:
        await self._c.request("DELETE", f"/saved-tasks/{enc(id)}")

    async def run(self, id: str, changes: Optional[Mapping[str, Any]] = None, **fields: Any) -> Task:
        return await self._c.request("POST", f"/saved-tasks/{enc(id)}/run", _core.body(changes, fields))


class AsyncSchedules:
    """Schedules, awaited (see ``Schedules``)."""

    def __init__(self, client: AsyncPilotfish) -> None:
        self._c = client

    async def list(self) -> List[Schedule]:
        return (await self._c.request("GET", "/schedules"))["schedules"]

    async def create(self, schedule: Optional[Mapping[str, Any]] = None, **fields: Any) -> Schedule:
        return await self._c.request("POST", "/schedules", _core.body(schedule, fields))

    async def update(self, saved_task_id: str, changes: Optional[Mapping[str, Any]] = None, **fields: Any) -> Schedule:
        return await self._c.request("PUT", f"/schedules/{enc(saved_task_id)}", _core.body(changes, fields))

    async def delete(self, saved_task_id: str) -> None:
        await self._c.request("DELETE", f"/schedules/{enc(saved_task_id)}")


class AsyncUsageApi:
    """Spending, awaited (see ``UsageApi``)."""

    def __init__(self, client: AsyncPilotfish) -> None:
        self._c = client

    async def get(self, *, days: Optional[int] = None, from_: Optional[str] = None, to: Optional[str] = None) -> Usage:
        return await self._c.request("GET", "/me/usage", query={"days": days, "from": from_, "to": to})
