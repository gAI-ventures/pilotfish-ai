"""The hosted client end to end against a local pilotfish server (scripted model, real Chromium, a fixture site) that a
launcher starts for it: tasks run, waited for, streamed, followed up; the error envelope as typed errors; a batch run to
its end with its signed batch.finished webhook checked by verify_webhook; identities and login links with an org key in
a shared project; saved tasks; usage; and the async client. Mirrors packages/server/src/sdk.e2e.test.ts.

Runs when the launcher sets:
    PILOTFISH_SDK_E2E_URL   the server's base URL
    PILOTFISH_SDK_E2E_KEY   the server's admin key
    PILOTFISH_SDK_E2E_SITE  a fixture origin where /anything?p=N shows "Loyalty points: N" (default 1,250); the scripted
                            model answers "<N> points"
"""

from __future__ import annotations

import asyncio
import json
import os
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Dict, Iterator, List

import pytest

from pilotfish import (
    AsyncPilotfish,
    AuthenticationError,
    BadRequestError,
    ConflictError,
    NotFoundError,
    Pilotfish,
    parse_webhook,
    verify_webhook,
)

URL = os.environ.get("PILOTFISH_SDK_E2E_URL", "").rstrip("/")
KEY = os.environ.get("PILOTFISH_SDK_E2E_KEY", "")
SITE = os.environ.get("PILOTFISH_SDK_E2E_SITE", "").rstrip("/")

pytestmark = pytest.mark.skipif(not URL, reason="set PILOTFISH_SDK_E2E_URL (a launcher starts a local pilotfish server)")

DELIVERIES: List[Dict[str, str]] = []


class _Hooks(BaseHTTPRequestHandler):
    def do_POST(self) -> None:  # noqa: N802
        n = int(self.headers.get("content-length") or 0)
        body = self.rfile.read(n).decode("utf-8")
        DELIVERIES.append({"signature": self.headers.get("pilotfish-signature") or "", "event": self.headers.get("pilotfish-event") or "", "body": body})
        self.send_response(204)
        self.end_headers()

    def log_message(self, *args: Any) -> None:
        pass


@pytest.fixture(scope="module")
def hook_url() -> Iterator[str]:
    server = ThreadingHTTPServer(("127.0.0.1", 0), _Hooks)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{server.server_address[1]}/hook"
    server.shutdown()


@pytest.fixture(scope="module")
def pf() -> Iterator[Pilotfish]:
    assert KEY and SITE, "PILOTFISH_SDK_E2E_KEY and PILOTFISH_SDK_E2E_SITE are needed too"
    with Pilotfish(api_key=KEY, base_url=URL) as c:
        yield c


def test_runs_a_task_to_its_result_streams_its_events_follows_up_and_lists_it(pf: Pilotfish) -> None:
    t = pf.tasks.create("how many loyalty points do I have", startUrl=f"{SITE}/account")
    assert t["url"] == f"{URL}/jobs/{t['id']}"
    assert f"/a/{t['id']}?t=" in t["answerUrl"]
    types: List[str] = []
    deadline = time.monotonic() + 120
    for e in pf.tasks.stream(t["id"], poll_interval=0.2):
        types.append(e["type"])
        assert time.monotonic() < deadline, f"still streaming after 120 s: {types[-5:]}"
    assert len(types) > 2
    assert len(set(types)) > 1
    done = pf.tasks.wait(t["id"], timeout=120)
    assert done["status"] == "done"
    assert "1,250 points" in done["result"]["result"]
    assert done["cost"]["totalUsd"] >= 0
    # Every event once: the whole list equals what the stream gave.
    assert [e["type"] for e in pf.tasks.events(t["id"])] == types
    # A follow-up carries on in the same session.
    nxt = pf.tasks.follow_up(t["id"], "read the points again")
    assert nxt["threadId"] == t["threadId"]
    again = pf.tasks.wait(nxt["id"], timeout=120)
    assert again["status"] == "done"
    assert "1,250 points" in again["result"]["result"]
    thread = pf.tasks.thread(t["id"])
    assert [j["id"] for j in thread["jobs"]] == [t["id"], nxt["id"]]
    assert nxt["id"] in [j["id"] for j in pf.tasks.list(limit=5).items]
    files = pf.tasks.files(t["id"])
    assert files["files"] == [] and files["total"] == 0


def test_raises_the_apis_errors_as_typed_exceptions_with_their_code_and_fields(pf: Pilotfish) -> None:
    with pytest.raises(NotFoundError) as missing:
        pf.tasks.get("job_nope")
    assert missing.value.status == 404
    with pytest.raises(BadRequestError) as bad:
        pf.tasks.create({"task": "", "maxSteps": 0})
    assert bad.value.code == "invalid_request"
    assert sorted(f["path"] for f in bad.value.fields or []) == ["maxSteps", "task"]
    with pytest.raises(AuthenticationError) as wrong:
        with Pilotfish(api_key="pf_wrong", base_url=URL, max_retries=0) as other:
            other.tasks.list()
    assert wrong.value.status == 401


def test_runs_a_batch_collects_the_results_and_signs_batch_finished(pf: Pilotfish, hook_url: str) -> None:
    b = pf.batches.run(
        {"name": "points", "tasks": [{"task": "how many loyalty points", "startUrl": f"{SITE}/a?p=10"}, {"task": "how many loyalty points", "startUrl": f"{SITE}/b?p=20"}], "webhookUrl": hook_url},
        poll_interval=0.3,
        timeout=120,
    )
    assert b["status"] == "done"
    assert b["counts"]["total"] == 2 and b["counts"]["done"] == 2
    assert [(i.get("result") or {}).get("result") for i in b["items"]] == ["10 points", "20 points"]
    assert b["id"] in [x["id"] for x in pf.batches.list().items]
    secret = pf.request("GET", "/org/webhook-secret")["secret"]
    deadline = time.monotonic() + 10
    while not any(d["event"] == "batch.finished" for d in DELIVERIES) and time.monotonic() < deadline:
        time.sleep(0.1)
    d = next(x for x in DELIVERIES if x["event"] == "batch.finished")
    assert verify_webhook(secret, d["signature"], d["body"])
    assert verify_webhook(secret, d["signature"], d["body"].encode("utf-8"))
    assert not verify_webhook("not-the-secret", d["signature"], d["body"])
    ev = parse_webhook(secret, d["signature"], d["body"])
    assert ev["type"] == "batch.finished"
    assert ev["batchId"] == b["id"]
    assert ev["data"]["status"] == "done"
    assert ev["data"]["counts"]["done"] == 2
    # Cancelling an ended batch is a conflict, typed.
    with pytest.raises(ConflictError) as e:
        pf.batches.cancel(b["id"])
    assert e.value.status == 409


def test_identities_and_login_links_with_an_org_key_and_saved_tasks_and_usage_in_personal(pf: Pilotfish) -> None:
    made = pf.request("POST", "/org/api-keys", {"label": "sdk e2e python"})
    external = f"user-{uuid.uuid4().hex[:8]}"
    with Pilotfish(api_key=made["key"], base_url=URL) as org:
        ada = org.identities.create(externalUserId=external, label="Ada")
        assert ada["id"].startswith("idn_")
        assert org.identities.create({"externalUserId": external})["existed"] is True
        page = org.identities.list(external_user_id=external)
        assert [i["id"] for i in page.items] == [ada["id"]]
        assert page.total == 1
        assert org.identities.update(ada["id"], label="Ada L.")["label"] == "Ada L."
        link = org.identities.login_link(ada["id"], ["example.com"])
        assert "/l/" in link["url"]
        cred = org.identities.add_credential(ada["id"], site="example.com", username="ada@example.com", password="s3cret-pass")
        assert cred["credential"].startswith("cred_")
        creds = org.identities.credentials(ada["id"])
        assert creds[0]["site"] == "example.com" and creds[0]["hasPassword"] is True
        assert "s3cret-pass" not in json.dumps(creds)
        org.identities.delete(ada["id"])
        with pytest.raises(NotFoundError):
            org.identities.get(ada["id"])
        # An org key's shared project has no saved tasks.
        with pytest.raises(ConflictError) as shared:
            org.saved_tasks.list()
        assert shared.value.code == "shared_project"
    saved = pf.saved_tasks.create(name="points", task="how many loyalty points", options={"startUrl": f"{SITE}/s?p=7"})
    assert saved["id"] in [s["id"] for s in pf.saved_tasks.list()]
    run = pf.tasks.wait(pf.saved_tasks.run(saved["id"])["id"], timeout=120)
    assert run["result"]["result"] == "7 points"
    pf.saved_tasks.delete(saved["id"])
    assert pf.schedules.list() == []
    assert isinstance(pf.usage.get(days=7), dict)


def test_the_async_client_runs_a_task_to_its_result() -> None:
    async def go() -> Dict[str, Any]:
        async with AsyncPilotfish(api_key=KEY, base_url=URL) as apf:
            t = await apf.tasks.run("how many loyalty points do I have", startUrl=f"{SITE}/account", poll_interval=0.3, timeout=120)
            events = [e async for e in apf.tasks.stream(t["id"], poll_interval=0.2)]
            assert events
            return t

    t = asyncio.run(go())
    assert t["status"] == "done"
    assert "1,250 points" in t["result"]["result"]
