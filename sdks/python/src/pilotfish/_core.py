"""What the sync and async clients share: options, URLs, headers, the retry decision, error parsing, bodies.

Both clients run the same loop around these functions and differ only in how they send and sleep, so their behaviour
cannot drift apart.
"""

from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass, field
from typing import Any, Dict, Generic, Iterator, List, Mapping, NamedTuple, Optional, Sequence, Tuple, TypeVar, Union
from urllib.parse import quote, unquote

from ._version import __version__
from .errors import PilotfishError, error_for

DEFAULT_BASE_URL = "https://pilotfish-be.gai.ventures"
#: The text the app sends to carry a paused task on.
CONTINUE_TEXT = "Continue the task from where you left off."
ENDED = frozenset({"done", "failed", "cancelled"})
USER_AGENT = f"pilotfish-sdk-python/{__version__}"
SHORT_ANSWERS = ("yes", "no", "done", "cancel", "skip")

T = TypeVar("T")
QueryValue = Union[str, int, float, bool, None]


def sign_in_of(question: Optional[Mapping[str, Any]]) -> Optional[Dict[str, Any]]:
    """A sign-in question's ways, checked, or None when the question is not a sign-in or carries none.

    Known ways only (one from a newer API is left out), each once; ``opensOn`` only when it is one of them (never a
    passkey); ``asked`` only when it is not. ``unclear`` is True when nothing could be read: the question asks how the
    person signs in (answer it with their words as text, never a password or code; or they sign in in the browser).
    Same rules as the TypeScript SDK's ``signInOf``.
    """
    from .types import SIGN_IN_WAYS

    if not question or question.get("category") != "login":
        return None
    s = question.get("signIn")
    if not isinstance(s, Mapping) or not isinstance(s.get("ways"), list) or not isinstance(s.get("providers"), list):
        return None
    ways: List[str] = []
    for w in s["ways"]:
        if w in SIGN_IN_WAYS and w not in ways:
            ways.append(w)
    providers: List[str] = []
    for p in s["providers"]:
        if isinstance(p, str) and p.strip() and p not in providers:
            providers.append(p)
    out: Dict[str, Any] = {"ways": ways, "providers": providers}
    opens = s.get("opensOn")
    if opens in ways and opens != "passkey":
        out["opensOn"] = opens
    asked = s.get("asked")
    if asked in SIGN_IN_WAYS and asked not in ways:
        out["asked"] = asked
    if isinstance(s.get("pageWords"), str) and s["pageWords"]:
        out["pageWords"] = s["pageWords"]
    out["unclear"] = not ways and not providers
    return out


@dataclass
class Page(Generic[T]):
    """One page of a list: its ``items`` and the ``next_cursor`` to ask for the next (None on the last page)."""

    items: List[T]
    next_cursor: Optional[str]
    #: How many there are in all, where the API says (identities).
    total: Optional[int] = field(default=None)

    def __iter__(self) -> Iterator[T]:
        return iter(self.items)

    def __len__(self) -> int:
        return len(self.items)


class DownloadedFile(NamedTuple):
    """A file's bytes, its content type, and its name (None when the server gave none)."""

    data: bytes
    content_type: str
    filename: Optional[str]


def env(name: str) -> Optional[str]:
    return os.environ.get(name) or None


def resolve(api_key: Optional[str], base_url: Optional[str]) -> Tuple[str, str]:
    """The API key and base URL, from the arguments or the environment."""
    key = api_key if api_key is not None else env("PILOTFISH_API_KEY")
    if not key:
        raise PilotfishError(0, {"error": "No API key: pass api_key, or set PILOTFISH_API_KEY (Org settings → API keys).", "code": "no_api_key"})
    base = base_url if base_url is not None else (env("PILOTFISH_BASE_URL") or DEFAULT_BASE_URL)
    return key, base.rstrip("/")


def enc(s: str) -> str:
    """A path segment, encoded as encodeURIComponent does."""
    return quote(str(s), safe="-_.!~*'()")


def query_params(query: Optional[Mapping[str, QueryValue]]) -> List[Tuple[str, str]]:
    """The query string's pairs: None left out, booleans as true/false."""
    out: List[Tuple[str, str]] = []
    for k, v in (query or {}).items():
        if v is None:
            continue
        out.append((k, ("true" if v else "false") if isinstance(v, bool) else str(v)))
    return out


def headers(api_key: str, has_body: bool) -> Dict[str, str]:
    h = {"authorization": f"Bearer {api_key}", "accept": "application/json", "user-agent": USER_AGENT}
    if has_body:
        h["content-type"] = "application/json"
    return h


def encode_body(body: Any) -> Optional[bytes]:
    return None if body is None else json.dumps(body).encode("utf-8")


def is_read(method: str) -> bool:
    return method.upper() in ("GET", "HEAD")


def network_retry_delay(read: bool, attempt: int, max_retries: int) -> Optional[float]:
    """Seconds to wait before sending again after a network failure, or None to give up. Only reads are sent again."""
    return 0.5 * 2**attempt if read and attempt < max_retries else None


def error_body(content: bytes, status: int) -> Dict[str, Any]:
    if not content:
        return {"error": f"HTTP {status}"}
    try:
        b = json.loads(content.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        return {"error": f"HTTP {status}"}
    if isinstance(b, dict):
        return b
    return {"error": b if isinstance(b, str) else json.dumps(b)}


def retry_after(body: Mapping[str, Any], header: Optional[str]) -> Optional[float]:
    v = body.get("retryAfterS")
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        return v
    if header is not None and re.fullmatch(r"\d+", header.strip()):
        return int(header.strip())
    return None


@dataclass
class Outcome:
    """What to do with a response: return it, send again after ``delay`` seconds, or raise ``error``."""

    action: str  # "ok" | "retry" | "raise"
    delay: float = 0.0
    error: Optional[PilotfishError] = None


def outcome(status: int, retry_after_header: Optional[str], content: bytes, read: bool, attempt: int, max_retries: int) -> Outcome:
    """The retry rule. 2xx and 3xx pass. A 429 refused the request before anything was made, so it is sent again
    whatever the method (after its ``retryAfterS``, else the ``Retry-After`` header, capped at 60 s, else 1, 2, 4... s).
    A 5xx is sent again only for a read (0.5, 1, 2... s). Anything else raises its typed error."""
    if 200 <= status < 400:
        return Outcome("ok")
    body = error_body(content, status)
    ra = retry_after(body, retry_after_header)
    if status == 429 and attempt < max_retries:
        return Outcome("retry", float(min(60, ra if ra is not None else 2**attempt)))
    # 501 (a feature this server does not have, such as MP4 replays) is not retried: it will not change.
    if read and status >= 500 and status != 501 and attempt < max_retries:
        return Outcome("retry", 0.5 * 2**attempt)
    if ra is not None and body.get("retryAfterS") is None:
        body = {**body, "retryAfterS": ra}
    return Outcome("raise", error=error_for(status, body))


def decode(status: int, content: bytes) -> Any:
    """A response's JSON (None for 204 or an empty body; the text when it is not JSON)."""
    if status == 204 or not content:
        return None
    text = content.decode("utf-8", errors="replace")
    try:
        return json.loads(text)
    except ValueError:
        return text


def filename_of(content_disposition: Optional[str]) -> Optional[str]:
    cd = content_disposition or ""
    star = re.search(r"filename\*=UTF-8''([^;]+)", cd, re.IGNORECASE)
    if star:
        return unquote(star.group(1).strip(), encoding="utf-8")
    plain = re.search(r'filename="([^"]+)"', cd, re.IGNORECASE)
    return plain.group(1) if plain else None


def body(base: Any, fields: Mapping[str, Any], key: Optional[str] = None) -> Dict[str, Any]:
    """A request body from a dict and keyword fields (the API's own names). A string (or, for ``key="tasks"``, a list)
    is put under ``key``."""
    if base is None:
        out: Dict[str, Any] = {}
    elif isinstance(base, Mapping):
        out = dict(base)
    elif key is not None and (isinstance(base, str) or (key == "tasks" and isinstance(base, Sequence))):
        out = {key: list(base) if key == "tasks" else base}
    else:
        raise TypeError(f"expected a dict{' or ' + ('a list' if key == 'tasks' else 'a string') if key else ''}, got {type(base).__name__}")
    out.update(fields)
    return out


def answer_body(question_id: str, answer: Any) -> Dict[str, Any]:
    """``"yes"``, ``"no"``, ``"done"``, ``"cancel"`` and ``"skip"`` are those answers; any other string is a text answer."""
    if isinstance(answer, str):
        a: Any = {"type": answer} if answer in SHORT_ANSWERS else {"type": "text", "text": answer}
    else:
        a = dict(answer)
    return {"questionId": question_id, "answer": a}


def wait_returns(task: Mapping[str, Any], return_on_question: bool) -> bool:
    if task.get("status") in ENDED:
        return True
    return bool(return_on_question and (task.get("status") == "needs_input" or task.get("question")))


def seq_of(event: Mapping[str, Any], after: int) -> int:
    s = event.get("seq")
    return max(after, s) if isinstance(s, int) and not isinstance(s, bool) else after

