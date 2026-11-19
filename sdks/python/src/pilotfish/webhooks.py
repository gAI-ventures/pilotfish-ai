"""Checking a webhook delivery.

Each one carries ``Pilotfish-Signature: t=<unix seconds>,v1=<hex>``, the HMAC-SHA256 of ``"<t>.<raw body>"`` with your
org's webhook secret (Org settings, or ``GET /org/webhook-secret``), and ``Pilotfish-Event``.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import re
import time
from typing import Optional, Union

from .errors import PilotfishError
from .types import WebhookEvent

__all__ = ["verify_webhook", "parse_webhook", "sign_webhook"]

Body = Union[str, bytes, bytearray, memoryview]


def _bytes(body: Body) -> bytes:
    return body.encode("utf-8") if isinstance(body, str) else bytes(body)


def _hmac_hex(secret: str, t: int, body: bytes) -> str:
    return hmac.new(secret.encode("utf-8"), str(t).encode("ascii") + b"." + body, hashlib.sha256).hexdigest()


def verify_webhook(secret: str, signature: Optional[str], body: Body, tolerance_s: float = 300, now: Optional[float] = None) -> bool:
    """True when ``signature`` (the ``Pilotfish-Signature`` header) signs ``body`` (the raw request body, exactly as
    received) with ``secret``, and is at most ``tolerance_s`` seconds old (default 300)."""
    if not signature:
        return False
    tm = re.search(r"(?:^|,)\s*t=(\d+)", signature)
    vm = re.search(r"(?:^|,)\s*v1=([0-9a-f]{64})", signature)
    if not tm or not vm:
        return False
    t = int(tm.group(1))
    current = int(time.time()) if now is None else now
    if not t or abs(current - t) > tolerance_s:
        return False
    return hmac.compare_digest(_hmac_hex(secret, t, _bytes(body)), vm.group(1))


def parse_webhook(secret: str, signature: Optional[str], body: Body, tolerance_s: float = 300, now: Optional[float] = None) -> WebhookEvent:
    """The delivery's event (``type``, ``jobId`` or ``batchId``, ``at``, ``data``), once its signature is checked.
    Raises PilotfishError (code ``bad_signature``) when it does not verify."""
    if not verify_webhook(secret, signature, body, tolerance_s=tolerance_s, now=now):
        raise PilotfishError(0, {"error": "The webhook's signature does not match (or is too old).", "code": "bad_signature"})
    return json.loads(_bytes(body).decode("utf-8"))


def sign_webhook(secret: str, body: Body, t: Optional[int] = None) -> str:
    """A ``Pilotfish-Signature`` header for ``body`` (tests of your own endpoint)."""
    ts = int(time.time()) if t is None else int(t)
    return f"t={ts},v1={_hmac_hex(secret, ts, _bytes(body))}"
