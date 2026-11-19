"""The local client: Chrome on your own machine and IP, driven from code through the open MCP's browser tools
(@gaiventures/pilotfish-mcp, MIT). No account, no API key, no model calls: your code decides each step.

It starts the open MCP as a child process (Node.js 22+) and speaks MCP to it over stdio (newline-delimited JSON-RPC
2.0). The MCP is ``node $PILOTFISH_MCP_CLI`` when that variable is set, else ``npx -y @gaiventures/pilotfish-mcp``.
"""

from __future__ import annotations

import base64
import json
import os
import shutil
import subprocess
import sys
import threading
from concurrent.futures import Future
from concurrent.futures import TimeoutError as FutureTimeout
from dataclasses import dataclass, field
from typing import IO, Any, Callable, Dict, List, Mapping, Optional, Sequence, Tuple, Union

from ._version import __version__
from .errors import PilotfishError

__all__ = ["LocalBrowser", "LocalToolError", "LocalQuestion", "ToolResult"]

PROTOCOL = "2025-06-18"
MCP_PACKAGE = "@gaiventures/pilotfish-mcp"


@dataclass
class ToolResult:
    """A tool's answer: its text (the page, what changed, what needs a person), pictures, and structured value."""

    text: str
    #: Each picture as ``(bytes, mime type)``.
    images: List[Tuple[bytes, str]] = field(default_factory=list)
    #: ``browser_query`` with a schema: ``{"value": ...}``.
    structured: Optional[Dict[str, Any]] = None
    is_error: bool = False
    #: ``query()`` only: the parsed result.
    value: Any = None


class LocalToolError(PilotfishError):
    """A tool answered with an error (a refused click, a stale ref, a bad expression). ``result`` has its whole text."""

    def __init__(self, tool: str, result: ToolResult) -> None:
        super().__init__(0, {"error": result.text or f"{tool} failed", "code": "tool_error"})
        self.tool = tool
        self.result = result


@dataclass
class LocalQuestion:
    """Something the MCP asks the person: ``confirm`` before a step that looks irreversible (pay, send, delete: answer
    True to allow), or ``handoff`` when the page needs a person (a sign-in, a code, a CAPTCHA: answer True once it is
    done in the browser window). None or False declines."""

    kind: str  # "confirm" | "handoff"
    message: str


OnQuestion = Callable[[LocalQuestion], Union[bool, str, None]]


def default_command() -> List[str]:
    """The command that starts the open MCP: ``node $PILOTFISH_MCP_CLI``, else npx."""
    cli = os.environ.get("PILOTFISH_MCP_CLI")
    if cli:
        return [shutil.which("node") or "node", cli]
    return ["npx.cmd" if sys.platform == "win32" else "npx", "-y", MCP_PACKAGE]


def settings_env(
    headless: Optional[bool] = None,
    allowed_hosts: Optional[Sequence[str]] = None,
    allow_private: bool = False,
    secrets: Optional[Mapping[str, Any]] = None,
    chrome: Optional[str] = None,
    env: Optional[Mapping[str, str]] = None,
) -> Dict[str, str]:
    """The MCP's settings as environment variables (https://pilotfish.gai.ventures/docs/open-settings)."""
    out: Dict[str, str] = {}
    if headless is not None:
        out["PILOTFISH_HEADLESS"] = "1" if headless else "0"
    if allowed_hosts:
        out["PILOTFISH_ALLOWED_HOSTS"] = ",".join(allowed_hosts)
    if allow_private:
        out["PILOTFISH_ALLOW_PRIVATE"] = "1"
    if secrets:
        out["PILOTFISH_SECRETS"] = json.dumps(dict(secrets))
    if chrome:
        out["PILOTFISH_CHROME"] = chrome
    out.update(env or {})
    return out


def _args(**kw: Any) -> Dict[str, Any]:
    """Only the arguments that are set: the MCP's schemas are strict, so no nulls."""
    return {k: v for k, v in kw.items() if v is not None}


class LocalBrowser:
    """Chrome on your own machine through the open MCP. Make one with ``LocalBrowser.start(...)``; close it with
    ``close()`` or a ``with`` block. The browser itself opens on the first call that needs it."""

    def __init__(self, proc: "subprocess.Popen[bytes]", on_question: Optional[OnQuestion], throw_on_error: bool, timeout: float) -> None:
        self._proc = proc
        self._on_question = on_question
        self._throw = throw_on_error
        self.timeout = timeout
        self._next_id = 1
        self._pending: Dict[int, "Future[Any]"] = {}
        self._lock = threading.Lock()
        self._write_lock = threading.Lock()
        self._closed = False
        self._exit_error: Optional[PilotfishError] = None
        self._stderr_tail = ""
        #: The MCP's own name and version (initialize).
        self.server_info: Optional[Dict[str, Any]] = None
        self._reader = threading.Thread(target=self._read_stdout, name="pilotfish-mcp-stdout", daemon=True)
        self._err_reader = threading.Thread(target=self._read_stderr, name="pilotfish-mcp-stderr", daemon=True)
        self._reader.start()
        self._err_reader.start()

    @classmethod
    def start(
        cls,
        headless: Optional[bool] = None,
        allowed_hosts: Optional[Sequence[str]] = None,
        allow_private: bool = False,
        secrets: Optional[Mapping[str, Any]] = None,
        chrome: Optional[str] = None,
        env: Optional[Mapping[str, str]] = None,
        command: Optional[Sequence[str]] = None,
        on_question: Optional[OnQuestion] = None,
        throw_on_error: bool = True,
        timeout: float = 300.0,
    ) -> "LocalBrowser":
        """Start the open MCP and connect to it.

        Args:
            headless: Hide the browser window. Default: a window where one can open. A hidden one cannot be signed in to by hand.
            allowed_hosts: Hostnames the browser may visit, ``*`` wildcards allowed. Default: any public site.
            allow_private: Allow localhost and private networks (testing your own app).
            secrets: Secrets typed as ``{{name}}``: ``{"name": "value"}`` or ``{"name": {"value", "totp", "allowedHosts"}}``.
                Never in any result.
            chrome: The browser executable. Default: found automatically.
            env: Further environment variables for the MCP (its settings).
            command: How to start the MCP: the command and its arguments. Default: ``node $PILOTFISH_MCP_CLI``, else
                ``npx -y @gaiventures/pilotfish-mcp``.
            on_question: Answers the MCP's questions to the person (see ``LocalQuestion``). Without it, irreversible
                steps are refused and a page that needs a person says so in the result.
            throw_on_error: Raise LocalToolError when a tool answers with an error (default); False returns the result.
            timeout: Per-call timeout, seconds (default 5 min: ``resume`` waits for a person).
        """
        cmd = list(command) if command else default_command()
        if not cmd:
            raise PilotfishError(0, {"error": "command is empty", "code": "mcp_start_failed"})
        exe = shutil.which(cmd[0]) or cmd[0]
        full_env = {**os.environ, **settings_env(headless, allowed_hosts, allow_private, secrets, chrome, env)}
        try:
            proc = subprocess.Popen([exe, *cmd[1:]], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=full_env)
        except OSError as e:
            raise PilotfishError(0, {"error": f"Could not start the pilotfish MCP: {e}", "code": "mcp_start_failed"}) from e
        b = cls(proc, on_question, throw_on_error, timeout)
        try:
            init = b._rpc(
                "initialize",
                {
                    "protocolVersion": PROTOCOL,
                    "capabilities": {"elicitation": {"form": {}}} if on_question else {},
                    "clientInfo": {"name": "pilotfish-sdk-python", "version": __version__},
                },
            )
        except BaseException:
            b._kill()
            raise
        b.server_info = (init or {}).get("serverInfo")
        b._notify("notifications/initialized", {})
        return b

    # ------------------------------------------------------------------------------------------- the tools

    def navigate(self, url: str, snapshot: Optional[bool] = None, expect: Optional[Mapping[str, Any]] = None, escalate: Optional[bool] = None) -> ToolResult:
        """Open an http(s) URL; returns what happened and the visible screen (``snapshot=False`` leaves the screen out).
        ``expect`` names what should follow: ``{"text", "gone", "url", "in", "within"}``."""
        return self.call("browser_navigate", _args(url=url, snapshot=snapshot, expect=expect, escalate=escalate))

    def snapshot(self, whole_page: bool = False) -> ToolResult:
        """The page as a compact outline with refs (``[e12]<button>Search``); ``whole_page`` for all of it."""
        return self.call("browser_snapshot", {"whole_page": True} if whole_page else {})

    def click(self, ref: str, snapshot: Optional[bool] = None, expect: Optional[Mapping[str, Any]] = None, escalate: Optional[bool] = None) -> ToolResult:
        return self.call("browser_click", _args(ref=ref, snapshot=snapshot, expect=expect, escalate=escalate))

    def type(self, ref: str, text: str, submit: Optional[bool] = None, snapshot: Optional[bool] = None, expect: Optional[Mapping[str, Any]] = None, escalate: Optional[bool] = None) -> ToolResult:
        """Replace a field's text (``{{name}}`` types a secret); ``submit`` presses Enter after."""
        return self.call("browser_type", _args(ref=ref, text=text, submit=submit, snapshot=snapshot, expect=expect, escalate=escalate))

    def select(self, ref: str, values: Sequence[str], snapshot: Optional[bool] = None, expect: Optional[Mapping[str, Any]] = None, escalate: Optional[bool] = None) -> ToolResult:
        return self.call("browser_select", _args(ref=ref, values=list(values), snapshot=snapshot, expect=expect, escalate=escalate))

    def press(self, key: str, snapshot: Optional[bool] = None, expect: Optional[Mapping[str, Any]] = None, escalate: Optional[bool] = None) -> ToolResult:
        """A key or shortcut: ``Enter``, ``Escape``, ``Control+a``."""
        return self.call("browser_press", _args(key=key, snapshot=snapshot, expect=expect, escalate=escalate))

    def scroll(self, direction: str, snapshot: Optional[bool] = None) -> ToolResult:
        """``up``, ``down``, ``left`` or ``right``, about one screen."""
        return self.call("browser_scroll", _args(direction=direction, snapshot=snapshot))

    def actions(self, steps: Sequence[Mapping[str, Any]], snapshot: Optional[bool] = None) -> ToolResult:
        """Up to 10 steps in one call (a form's fields and its submit): ``{"action": "click", "ref"}``,
        ``{"action": "type", "ref", "text", "submit"?}``, ``{"action": "select", "ref", "values"}``,
        ``{"action": "press", "key"}``, ``{"action": "scroll", "direction"}``, ``{"action": "wait", "seconds", "until"?, "gone"?}``."""
        return self.call("browser_actions", _args(actions=[dict(s) for s in steps], snapshot=snapshot))

    def query(self, expression: str, schema: Optional[Mapping[str, Any]] = None) -> ToolResult:
        """Read values with a JavaScript expression that returns JSON: ``.value`` is the parsed result. It cannot change
        the page. With ``schema`` (a JSON Schema) the result is checked against it."""
        r = self.call("browser_query", _args(expression=expression, schema=dict(schema) if schema is not None else None))
        if r.structured is not None and "value" in r.structured:
            r.value = r.structured["value"]
        else:
            try:
                r.value = json.loads(r.text)
            except ValueError:
                r.value = r.text
        return r

    def find(self, query: str) -> ToolResult:
        """Elements anywhere on the page by their words, best match first (comma-separate several targets)."""
        return self.call("browser_find", {"query": query})

    def get_text(self, max_chars: Optional[int] = None, selector: Optional[str] = None) -> ToolResult:
        """The page's readable text (PDFs too), or one element's (``selector``)."""
        return self.call("browser_get_text", _args(max_chars=max_chars, selector=selector))

    def screenshot(self) -> bytes:
        """A JPEG of the viewport."""
        r = self.call("browser_screenshot", {})
        if not r.images:
            r.is_error = True
            raise LocalToolError("browser_screenshot", r)
        return r.images[0][0]

    def wait(self, seconds: float, until: Optional[str] = None, gone: Optional[str] = None, in_: Optional[str] = None, snapshot: Optional[bool] = None) -> ToolResult:
        """Wait up to ``seconds`` (0.5-10), or until ``until`` appears or ``gone`` goes (within the element ``in_``)."""
        return self.call("browser_wait", _args(seconds=seconds, until=until, gone=gone, snapshot=snapshot, **({"in": in_} if in_ is not None else {})))

    def resume(self, timeout_s: Optional[float] = None) -> ToolResult:
        """After a result said NEEDS A PERSON: wait (default 300 s) until the person has dealt with the page."""
        return self.call("browser_resume", _args(timeout_s=timeout_s))

    def tabs(self, switch_to: Optional[str] = None) -> ToolResult:
        """Open tabs, or switch to one (``"t2"``)."""
        return self.call("browser_tabs", _args(switch_to=switch_to))

    def page_tool(self, tool: str, arguments: Optional[Mapping[str, Any]] = None) -> ToolResult:
        """A tool the page itself offers (WebMCP), as its snapshot's PAGE TOOLS line lists it."""
        return self.call("browser_page_tool", {"tool": tool, "arguments": dict(arguments or {})})

    def tools(self) -> List[Dict[str, Any]]:
        """The tools the MCP offers now (``name``, ``description``, ``inputSchema``)."""
        return (self._rpc("tools/list", {}) or {}).get("tools", [])

    def call(self, name: str, args: Optional[Mapping[str, Any]] = None, timeout: Optional[float] = None) -> ToolResult:
        """Any tool by name, with its arguments as the MCP takes them."""
        raw = self._rpc("tools/call", {"name": name, "arguments": dict(args or {})}, timeout=timeout) or {}
        content = raw.get("content") or []
        r = ToolResult(
            text="\n".join(c.get("text") or "" for c in content if c.get("type") == "text"),
            images=[(base64.b64decode(c["data"]), c.get("mimeType") or "image/jpeg") for c in content if c.get("type") == "image" and c.get("data")],
            structured=raw.get("structuredContent"),
            is_error=raw.get("isError") is True,
        )
        if r.is_error and self._throw:
            raise LocalToolError(name, r)
        return r

    def close(self) -> None:
        """Close the browser and stop the MCP."""
        if self._closed:
            return
        try:
            self.call("browser_close", {}, timeout=30)
        except Exception:
            pass
        self._closed = True
        try:
            if self._proc.stdin:
                self._proc.stdin.close()
        except OSError:
            pass
        try:
            self._proc.wait(5)
        except subprocess.TimeoutExpired:
            self._kill()

    def __enter__(self) -> "LocalBrowser":
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()

    def __del__(self) -> None:  # a forgotten close() leaves no MCP behind
        try:
            if self._proc.poll() is None:
                self._proc.kill()
        except Exception:
            pass

    # ------------------------------------------------------------------------------------------- JSON-RPC over stdio

    def _kill(self) -> None:
        self._closed = True
        try:
            self._proc.kill()
            self._proc.wait(5)
        except Exception:
            pass

    def _send(self, msg: Mapping[str, Any]) -> None:
        stdin = self._proc.stdin
        if stdin is None:
            return
        data = (json.dumps(msg) + "\n").encode("utf-8")
        with self._write_lock:
            try:
                stdin.write(data)
                stdin.flush()
            except (OSError, ValueError):
                pass

    def _notify(self, method: str, params: Any) -> None:
        if not self._closed:
            self._send({"jsonrpc": "2.0", "method": method, "params": params})

    def _rpc(self, method: str, params: Any, timeout: Optional[float] = None) -> Any:
        fut: "Future[Any]" = Future()
        with self._lock:
            if self._closed:
                raise self._exit_error or PilotfishError(0, {"error": "This browser is closed.", "code": "closed"})
            id = self._next_id
            self._next_id += 1
            self._pending[id] = fut
        self._send({"jsonrpc": "2.0", "id": id, "method": method, "params": params})
        wait = self.timeout if timeout is None else timeout
        try:
            return fut.result(wait)
        except FutureTimeout:
            with self._lock:
                self._pending.pop(id, None)
            self._notify("notifications/cancelled", {"requestId": id, "reason": "timeout"})
            raise PilotfishError(0, {"error": f"{method} took longer than {round(wait)} s", "code": "timeout"}) from None

    def _read_stdout(self) -> None:
        out: Optional[IO[bytes]] = self._proc.stdout
        if out is not None:
            for raw in out:
                line = raw.decode("utf-8", errors="replace").strip()
                if not line:
                    continue
                try:
                    msg = json.loads(line)
                except ValueError:
                    continue
                if not isinstance(msg, dict):
                    continue
                if msg.get("method") and "id" in msg:
                    threading.Thread(target=self._on_request, args=(msg["id"], msg["method"], msg.get("params") or {}), daemon=True).start()
                elif "id" in msg:
                    try:
                        rid = int(msg["id"])
                    except (TypeError, ValueError):
                        continue
                    with self._lock:
                        fut = self._pending.pop(rid, None)
                    if fut is None:
                        continue
                    err = msg.get("error")
                    if err:
                        fut.set_exception(PilotfishError(0, {"error": err.get("message") or "MCP error", "code": f"mcp_{err.get('code', 'error')}"}))
                    else:
                        fut.set_result(msg.get("result"))
        # The MCP's output ended: it stopped.
        try:
            code = self._proc.wait(5)
        except subprocess.TimeoutExpired:
            code = None
        self._err_reader.join(1)
        tail = " ".join(self._stderr_tail.strip().splitlines()[-3:])
        self._fail(PilotfishError(0, {"error": f"The pilotfish MCP stopped (exit {code}).{(' ' + tail) if tail else ''}", "code": "mcp_exited"}))

    def _read_stderr(self) -> None:
        err = self._proc.stderr
        if err is None:
            return
        for raw in err:
            self._stderr_tail = (self._stderr_tail + raw.decode("utf-8", errors="replace"))[-4000:]

    def _on_request(self, id: Any, method: str, params: Mapping[str, Any]) -> None:
        """The MCP's requests to us: ping, and questions for the person (elicitation)."""
        if method == "ping":
            return self._send({"jsonrpc": "2.0", "id": id, "result": {}})
        if method == "elicitation/create" and self._on_question is not None:
            schema = params.get("requestedSchema") or {}
            props = schema.get("properties") or {} if isinstance(schema, dict) else {}
            kind = "handoff" if "done" in props else "confirm"
            try:
                answer = self._on_question(LocalQuestion(kind, str(params.get("message") or "")))
            except Exception:
                answer = None
            if answer is None or answer is False:
                return self._send({"jsonrpc": "2.0", "id": id, "result": {"action": "decline"}})
            content = {"done": True} if kind == "handoff" else {"answer": "yes" if answer is True else str(answer)}
            return self._send({"jsonrpc": "2.0", "id": id, "result": {"action": "accept", "content": content}})
        self._send({"jsonrpc": "2.0", "id": id, "error": {"code": -32601, "message": f"Method not found: {method}"}})

    def _fail(self, e: PilotfishError) -> None:
        with self._lock:
            if not self._closed:
                self._exit_error = e
            self._closed = True
            pending, self._pending = self._pending, {}
        for fut in pending.values():
            if not fut.done():
                fut.set_exception(e)
