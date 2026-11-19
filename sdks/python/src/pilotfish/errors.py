"""The API's errors as typed exceptions.

Every error response is ``{error, code, hint?, docs?, fields?, retryAfterS?}``
(https://pilotfish.gai.ventures/docs/api#errors): the class says what kind it is, ``code`` exactly which.
"""

from __future__ import annotations

from typing import Any, Dict, List, Mapping, Optional

__all__ = [
    "PilotfishError",
    "BadRequestError",
    "AuthenticationError",
    "PaymentRequiredError",
    "PermissionDeniedError",
    "NotFoundError",
    "ConflictError",
    "RateLimitError",
    "ServerError",
    "ConnectionError",
    "WaitTimeoutError",
    "error_for",
]


def _number(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


class PilotfishError(Exception):
    """Any error the API answered with, or a request that never got an answer (``status`` 0).

    Attributes:
        status: HTTP status (0 when the request never got an answer).
        code: The error's code, e.g. ``no_credits``, ``one_session``, ``not_found`` (the HTTP status as text when
            the body had none).
        hint: What to do about it, when the API says.
        docs: The documentation page for this error.
        fields: The invalid fields of a 400: a list of ``{"path", "message"}``.
        retry_after_s: Seconds to wait before trying again (429).
        body: The whole response body (other figures some errors carry: ``balanceUsd``, ``limitUsd``, ``threadId``...).
    """

    status: int
    code: str
    hint: Optional[str]
    docs: Optional[str]
    fields: Optional[List[Dict[str, Any]]]
    retry_after_s: Optional[float]
    body: Dict[str, Any]

    def __init__(self, status: int, body: Optional[Mapping[str, Any]] = None, message: Optional[str] = None) -> None:
        b: Dict[str, Any] = dict(body or {})
        err = b.get("error")
        text = message if message is not None else (err if isinstance(err, str) else f"HTTP {status}")
        super().__init__(text)
        self.message = text
        self.status = status
        self.body = b
        code = b.get("code")
        self.code = code if isinstance(code, str) and code else str(status)
        self.hint = b["hint"] if isinstance(b.get("hint"), str) else None
        self.docs = b["docs"] if isinstance(b.get("docs"), str) else None
        self.fields = b["fields"] if isinstance(b.get("fields"), list) else None
        self.retry_after_s = b["retryAfterS"] if _number(b.get("retryAfterS")) else None

    def __repr__(self) -> str:
        return f"{type(self).__name__}(status={self.status}, code={self.code!r}, message={self.message!r})"


class BadRequestError(PilotfishError):
    """400 (or 422): the request is not valid (``fields`` says which parts)."""


class AuthenticationError(PilotfishError):
    """401: no API key, or one that is wrong or revoked."""


class PaymentRequiredError(PilotfishError):
    """402: out of credits (``no_credits``), an allowance used (``allocation_used``), or the org's monthly limit (``org_limit``)."""


class PermissionDeniedError(PilotfishError):
    """403: not allowed for this key or person (``admins_only``, ``shared_project``...)."""


class NotFoundError(PilotfishError):
    """404 (or 410): no such task, batch or identity, or not one this key may see."""


class ConflictError(PilotfishError):
    """409: a task is already running (``one_session``, ``identity_busy``), or the thing is not in a state for that."""


class RateLimitError(PilotfishError):
    """429: too many requests or tasks waiting (``rate_limited``, ``queue_full``, ``start_rate``); ``retry_after_s`` says when to try again."""


class ServerError(PilotfishError):
    """5xx: the server failed. Safe to retry a read."""


class ConnectionError(PilotfishError):  # noqa: A001 - the SDK's own name, as in the TypeScript SDK
    """The request never got an answer: the network, or the client's own timeout. ``__cause__`` is the underlying error."""

    def __init__(self, message: str, cause: Optional[BaseException] = None) -> None:
        super().__init__(0, {"error": message, "code": "connection_error"})
        self.cause = cause
        if cause is not None:
            self.__cause__ = cause


class WaitTimeoutError(PilotfishError):
    """``wait()`` gave up before the task or batch ended (the task carries on)."""

    def __init__(self, message: str) -> None:
        super().__init__(0, {"error": message, "code": "wait_timeout"})


def error_for(status: int, body: Mapping[str, Any]) -> PilotfishError:
    """The error class for a status."""
    if status in (400, 422):
        return BadRequestError(status, body)
    if status == 401:
        return AuthenticationError(status, body)
    if status == 402:
        return PaymentRequiredError(status, body)
    if status == 403:
        return PermissionDeniedError(status, body)
    if status in (404, 410):
        return NotFoundError(status, body)
    if status == 409:
        return ConflictError(status, body)
    if status == 429:
        return RateLimitError(status, body)
    if status >= 500:
        return ServerError(status, body)
    return PilotfishError(status, body)
