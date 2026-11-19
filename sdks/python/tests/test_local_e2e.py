"""The local client against the open MCP's CLI over stdio and a real Chrome: no API key, no model calls. The MCP is this
repository's build (packages/mcp/dist/cli.js), or the one named by PILOTFISH_MCP_CLI. Runs with PILOTFISH_E2E=1.
Mirrors packages/sdk/src/local.e2e.test.ts."""

from __future__ import annotations

import os
import re
import shutil
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Iterator, List

import pytest

from pilotfish import LocalBrowser, LocalQuestion, LocalToolError

pytestmark = pytest.mark.skipif(os.environ.get("PILOTFISH_E2E") != "1", reason="set PILOTFISH_E2E=1 (needs the built open MCP and Chrome)")

REPO = Path(__file__).resolve().parents[3]
CLI = os.environ.get("PILOTFISH_MCP_CLI") or str(REPO / "packages" / "mcp" / "dist" / "cli.js")

SHOP = """<!doctype html><title>Lamp shop</title><main><h1>Lamps</h1>
<ul id="items"><li class="item" data-price="25">Blue lamp</li><li class="item" data-price="40">Red lamp</li></ul>
<label>Name <input id="name"></label> <button id="save" onclick="document.getElementById('out').textContent='Saved: '+document.getElementById('name').value">Save</button>
<p id="out"></p>
<button id="order" onclick="document.getElementById('out').textContent='Order placed'">Place order</button>
</main>"""


class _Shop(BaseHTTPRequestHandler):
    def do_GET(self) -> None:  # noqa: N802
        body = SHOP.encode("utf-8")
        self.send_response(200)
        self.send_header("content-type", "text/html")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args: Any) -> None:
        pass


@pytest.fixture(scope="module")
def origin() -> Iterator[str]:
    assert Path(CLI).exists(), f"{CLI} is missing: npm run build first"
    server = ThreadingHTTPServer(("127.0.0.1", 0), _Shop)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{server.server_address[1]}"
    server.shutdown()


def start(**o: Any) -> LocalBrowser:
    env = {k: os.environ[k] for k in ["PILOTFISH_ADBLOCK_OFFLINE"] if os.environ.get(k)}
    chrome = os.environ.get("PILOTFISH_CHROME")
    return LocalBrowser.start(command=[shutil.which("node") or "node", CLI], headless=True, allow_private=True, env=env, chrome=chrome, **o)


def ref_of(pattern: str, text: str) -> str:
    m = re.search(pattern, text)
    assert m, f"{pattern} not in:\n{text}"
    return m.group(1)


def test_navigates_finds_types_clicks_reads_and_screenshots_then_closes(origin: str) -> None:
    with start() as b:
        assert b.server_info and b.server_info.get("name")
        assert "browser_navigate" in [t["name"] for t in b.tools()]
        nav = b.navigate(f"{origin}/")
        assert "Lamps" in nav.text
        name = ref_of(r"\[(e\d+)\]<input[^\n]*", b.find("Name input").text)
        save = ref_of(r"\[(e\d+)\]<button[^>]*>Save", b.snapshot().text)
        b.type(name, "Ada")
        b.click(save, expect={"text": "Saved: Ada"})
        prices = b.query("[...document.querySelectorAll('.item')].map((e) => Number(e.dataset.price))")
        assert prices.value == [25, 40]
        typed = b.query("({count: document.querySelectorAll('.item').length})", schema={"type": "object", "properties": {"count": {"type": "number"}}, "required": ["count"]})
        assert typed.value == {"count": 2}
        assert "Saved: Ada" in b.get_text(selector="#out").text
        jpeg = b.screenshot()
        assert jpeg[:2] == b"\xff\xd8"
        # A stale ref is the tool's error, raised with its text.
        with pytest.raises(LocalToolError) as e:
            b.click("e9999")
        assert e.value.tool == "browser_click"
        assert e.value.result.is_error and e.value.result.text
    with pytest.raises(Exception):
        b.snapshot()


def test_asks_on_question_before_an_irreversible_step_and_the_step_runs_on_a_yes(origin: str) -> None:
    asked: List[LocalQuestion] = []

    def on_question(q: LocalQuestion) -> bool:
        asked.append(q)
        return True

    with start(on_question=on_question) as b:
        b.navigate(f"{origin}/")
        order = ref_of(r"\[(e\d+)\]<button[^>]*>Place order", b.snapshot().text)
        b.click(order)
        assert len(asked) == 1
        assert asked[0].kind == "confirm"
        assert "Order placed" in b.get_text(selector="#out").text


def test_without_on_question_an_irreversible_step_is_refused_and_nothing_happens(origin: str) -> None:
    with start() as b:
        b.navigate(f"{origin}/")
        order = ref_of(r"\[(e\d+)\]<button[^>]*>Place order", b.snapshot().text)
        try:
            r = b.click(order)
        except LocalToolError as e:
            r = e.result
        assert re.search(r"confirm|approv|refus|irreversible", r.text, re.IGNORECASE)
        assert "Order placed" not in b.get_text(selector="#out").text
