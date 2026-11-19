"""Webhook signatures: made and checked as the server signs them (packages/server/src/webhooks.ts)."""

from __future__ import annotations

import json
import re

import pytest

from pilotfish import PilotfishError, parse_webhook, sign_webhook, verify_webhook

BODY = json.dumps({"type": "batch.finished", "batchId": "bat_1", "at": 1, "data": {"status": "done"}})
NOW = 1_800_000_000


def test_verifies_a_signature_made_with_the_secret() -> None:
    sig = sign_webhook("whsec", BODY, NOW)
    assert re.fullmatch(r"t=1800000000,v1=[0-9a-f]{64}", sig)
    assert verify_webhook("whsec", sig, BODY, now=NOW)
    assert verify_webhook("whsec", sig, BODY.encode("utf-8"), now=NOW)
    assert verify_webhook("whsec", sig, bytearray(BODY.encode("utf-8")), now=NOW)
    assert verify_webhook("whsec", sig, BODY, now=NOW + 300)


def test_refuses_a_changed_body_another_secret_or_an_old_one() -> None:
    sig = sign_webhook("whsec", BODY, NOW)
    assert not verify_webhook("whsec", sig, BODY + " ", now=NOW)
    assert not verify_webhook("other", sig, BODY, now=NOW)
    assert not verify_webhook("whsec", sig, BODY, now=NOW + 301)
    assert not verify_webhook("whsec", sig, BODY, now=NOW - 301)
    assert verify_webhook("whsec", sig, BODY, now=NOW + 1000, tolerance_s=1000)


def test_refuses_no_header_or_a_malformed_one() -> None:
    assert not verify_webhook("whsec", None, BODY)
    assert not verify_webhook("whsec", "", BODY)
    assert not verify_webhook("whsec", "t=1800000000", BODY, now=NOW)
    assert not verify_webhook("whsec", "v1=" + "0" * 64, BODY, now=NOW)


def test_parses_a_verified_delivery_and_raises_on_a_bad_one() -> None:
    sig = sign_webhook("whsec", BODY, NOW)
    ev = parse_webhook("whsec", sig, BODY, now=NOW)
    assert ev["type"] == "batch.finished" and ev["batchId"] == "bat_1"
    with pytest.raises(PilotfishError, match="does not match") as e:
        parse_webhook("other", sig, BODY, now=NOW)
    assert e.value.code == "bad_signature"


def test_matches_the_servers_own_signature() -> None:
    # HMAC-SHA256("secret", "1700000000.{}") as the server signs it.
    assert sign_webhook("secret", "{}", 1700000000) == "t=1700000000,v1=b8569b78799ff9e3cbff0fc2d63a33a2b57f3282abd07c37ae5e8e7d79a5f163"
    assert verify_webhook("secret", "t=1700000000,v1=b8569b78799ff9e3cbff0fc2d63a33a2b57f3282abd07c37ae5e8e7d79a5f163", "{}", now=1700000000)
