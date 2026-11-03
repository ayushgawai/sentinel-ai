"""Severity thresholds — bench hook.

Until a measured precision curve is loaded, DEFAULT_* apply and callers must pass
allow_default=True. When bench/thresholds.json exists, load it.
"""

from __future__ import annotations

import json
from pathlib import Path

from contracts import Severity

_ROOT = Path(__file__).resolve().parents[2]
_BENCH_FILE = _ROOT / "bench" / "thresholds.json"

# Defaults until bench/thresholds.json supplies a measured precision curve.
DEFAULT_MINOR_AT = 0.55
DEFAULT_SEVERE_AT = 0.85

_MINOR_AT = DEFAULT_MINOR_AT
_SEVERE_AT = DEFAULT_SEVERE_AT
_LOADED_FROM_BENCH = False


def reload_thresholds(path: Path | None = None) -> bool:
    """Load bench/thresholds.json if present. Returns True if loaded."""
    global _MINOR_AT, _SEVERE_AT, _LOADED_FROM_BENCH
    p = path or _BENCH_FILE
    if not p.is_file():
        _LOADED_FROM_BENCH = False
        _MINOR_AT, _SEVERE_AT = DEFAULT_MINOR_AT, DEFAULT_SEVERE_AT
        return False
    data = json.loads(p.read_text())
    _MINOR_AT = float(data["minor_at"])
    _SEVERE_AT = float(data["severe_at"])
    _LOADED_FROM_BENCH = True
    return True


def using_bench() -> bool:
    return _LOADED_FROM_BENCH


def severity_from_fused(
    fused_prob: float,
    *,
    allow_default: bool = False,
) -> Severity:
    if not _LOADED_FROM_BENCH and not allow_default:
        raise RuntimeError(
            "severity thresholds are uncalibrated defaults; "
            "pass allow_default=True only in tests until calibrated, "
            "or add bench/thresholds.json"
        )
    if fused_prob >= _SEVERE_AT:
        return Severity.SEVERE
    if fused_prob >= _MINOR_AT:
        return Severity.MINOR
    return Severity.NONE


# Try load on import (no-op if missing).
reload_thresholds()
