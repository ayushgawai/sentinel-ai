"""Dispatch review before any outside call: local rules + an independent Muse Spark Open evidence check.

Muse (Meta, via Baseten) reads a short TEXT summary of the incident (never images) and verifies that the
facts consistently describe a visible weapon. It does not authorize calls itself (asked to, it declined:
"requires human verification"); the fixed rules own that. A call goes ahead only when the rules pass AND
Muse verifies the evidence. Any failure, timeout or unclear answer blocks the call (fail closed).
"""

from __future__ import annotations

import json
import os
import re
import threading
from dataclasses import dataclass
from typing import Any

_lock = threading.Lock()


@dataclass
class _Row:
    state: str = "pending"
    model_id: str = ""
    http_status: int | None = None
    detail: str = ""


_rows = {"muse_review": _Row(), "rules": _Row()}

REVIEW_PROMPT = (
    "You are the evidence verifier for a campus security camera system. You do NOT decide whether to call "
    "anyone: fixed rules and the operator own that. You get the text facts behind one incident. Check only "
    "whether they consistently describe a visible weapon carried by a person (classification, detector and "
    "description agree, nothing contradictory or implausible). "
    'Reply with ONE JSON object: {"evidence_verified": true|false, "reason": "<max 15 words>"}.'
)


def configured() -> bool:
    return bool(os.environ.get("BASETEN_API_KEY", "").strip())


def public_status() -> dict[str, dict[str, Any]]:
    with _lock:
        return {name: vars(row).copy() for name, row in _rows.items()}


def redact(text: str) -> str:
    out = str(text)
    secret = os.environ.get("BASETEN_API_KEY", "").strip()
    if len(secret) >= 6:
        out = out.replace(secret, "[redacted]")
    return re.sub(r"(?i)(api-key|bearer)\s+\S+", r"\1 [redacted]", out)


def decide(local_ok: bool, local_reason: str, review_ok: bool, allow: bool | None) -> tuple[bool, str]:
    """Dispatch only when local rules pass and the Muse review explicitly allows it."""
    if not local_ok:
        return False, local_reason or "blocked"
    if not review_ok:
        return False, "review_failed"
    if allow is True:
        return True, "ok"
    if allow is False:
        return False, "review_declined"
    return False, "review_unclear"


def review_dispatch(rec: Any, local_ok: bool, local_reason: str) -> tuple[bool, str]:
    _set("rules", state="active", detail=local_reason or ("ok" if local_ok else "blocked"))
    if not local_ok:
        return decide(local_ok, local_reason, True, None)
    try:
        allow, reason = _muse_review(_incident_text(rec))
        _set("muse_review", state="active", detail=f"{'Yes' if allow else 'No'}: {reason}"[:120])
        ok, why = decide(True, "", True, allow)
    except Exception as exc:  # noqa: BLE001 — never a fake success
        _set("muse_review", state="failed", detail=redact(type(exc).__name__))
        ok, why = decide(True, "", False, None)
    print(f"[track] muse_review={why}", flush=True)
    return ok, why


def _set(name: str, **fields: Any) -> None:
    with _lock:
        for key, value in fields.items():
            setattr(_rows[name], key, value)


def _incident_text(rec: Any) -> str:
    """Facts only, from the incident record (never images, never router scores)."""
    import math

    cam = str(getattr(rec, "camera_id", "") or "unknown")
    cls = getattr(getattr(rec, "class_token", None), "value", "UNKNOWN")
    lp = getattr(rec, "class_logprob_calibrated", None)
    conf = f"{math.exp(lp):.2f}" if isinstance(lp, (int, float)) and lp <= 0 else "n/a"
    rules = ", ".join(str(r) for r in (getattr(rec, "rules_fired", None) or [])) or "none"
    where = str(getattr(rec, "location_text", "") or cam)
    person = str(getattr(rec, "person_description", "") or "not described").replace("\n", " ")[:200]
    return (f"Live campus camera incident at {where} ({cam}). Vision model classification: {cls} "
            f"(confidence {conf}). Detector rules fired: {rules}. Weapon detector: Meta SAM 3.1 segmented a "
            f"weapon on a tracked person. Person description: {person}.")


def _muse_review(incident: str) -> tuple[bool | None, str]:
    from services.brain.muse_client import MuseClient

    z = MuseClient(timeout_s=45.0)
    _set("muse_review", model_id=z.model)
    raw = z._post_json("/v1/chat/completions", {
        "model": z.model,
        "messages": [{"role": "system", "content": REVIEW_PROMPT}, {"role": "user", "content": incident}],
        "max_tokens": 3000,
        "temperature": 0.0,
    })
    _set("muse_review", http_status=200)
    text = str((((raw.get("choices") or [{}])[0].get("message") or {}).get("content")) or "")
    start, end = text.find("{"), text.rfind("}")
    obj = json.loads(text[start:end + 1]) if start >= 0 and end > start else {}
    allow = obj.get("evidence_verified")
    return (allow if isinstance(allow, bool) else None), str(obj.get("reason", ""))[:120]
