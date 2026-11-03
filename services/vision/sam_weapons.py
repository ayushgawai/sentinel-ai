"""Live weapon detection with Meta SAM 3.1 on enlarged person crops.

CCTV weapons are only 10-25 px, so each tracked person is padded, cropped and enlarged to 512 px:
SAM 3.1 then segments the gun at the resolution it was built for. Each tracked person is checked about every
CHECK_S seconds of clip time on a background thread so the video loop never waits. Results are
cached on disk by crop hash: replaying the same footage reuses the real SAM answer instead of paying
again. Interface: armed / boxes_xywh, plus observe(frame, tracks).
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

import cv2

from services import activity
from services.usage import add as usage_add

ROOT = Path(__file__).resolve().parents[2]
CACHE = Path(os.environ.get("CS_SAM_CACHE", ROOT / "data" / "runtime" / "sam_weapon_cache.json"))
MODEL = os.environ.get("META_SAM_MODEL_ID", "sam-3.1")
CHECK_S = float(os.environ.get("CS_SAM_CHECK_S", "4.0"))  # clip seconds between checks of one person
SHOW_S = 1.5  # how long a detected weapon box stays drawn
MAX_CALLS = int(os.environ.get("CS_SAM_MAX_CALLS", "400"))  # per run (cache hits are free)
MIN_CONF = float(os.environ.get("CS_SAM_MIN_CONF", "0.45"))
CROP_SIDE = 512
CONCEPTS = tuple(os.environ.get("CS_SAM_CONCEPTS", "gun").split(","))


def _crop(img, box: tuple[float, float, float, float]):
    """Person box (xywh) padded and snapped to an 8 px grid, so replays hit the cache."""
    x, y, w, h = box
    H, W = img.shape[:2]
    x1, y1 = int(max(0, x - w / 4)) // 8 * 8, int(max(0, y - h / 8)) // 8 * 8
    x2, y2 = min(W, int(x + w + w / 4) // 8 * 8 + 8), min(H, int(y + h + h / 8) // 8 * 8 + 8)
    if x2 - x1 < 16 or y2 - y1 < 16:
        return None, (0, 0, 1.0)
    s = CROP_SIDE / max(x2 - x1, y2 - y1)
    crop = cv2.resize(img[y1:y2, x1:x2], None, fx=s, fy=s, interpolation=cv2.INTER_CUBIC)
    return crop, (x1, y1, s)


class SamWeapons:
    width = 960.0
    height = 540.0

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._pool = ThreadPoolExecutor(max_workers=int(os.environ.get("CS_SAM_WORKERS", "3")))
        self._cache: dict[str, list] = json.loads(CACHE.read_text()) if CACHE.is_file() else {}
        self.reset()

    def reset(self) -> None:
        with self._lock:
            self._next_check: dict[tuple[str, str], float] = {}
            self._hits: dict[str, list[dict[str, Any]]] = {}  # camera -> [{type, box, conf, t, track}]
            self._inflight: set[tuple[str, str]] = set()
            self.calls = 0
            self.cache_hits = 0
            self._epoch = time.monotonic()

    # ------------------------------------------------------------- pipeline hooks
    def observe(self, fr: Any, tracks: list[Any], clip_t: float) -> None:
        img = getattr(fr, "image", None)
        if img is None:
            return
        cam = fr.camera_id.lower()
        for tr in tracks:
            key = (cam, tr.track_id)
            with self._lock:
                if key in self._inflight or clip_t < self._next_check.get(key, -1.0):
                    continue
                self._next_check[key] = clip_t + CHECK_S
                self._inflight.add(key)
            crop, (ox, oy, s) = _crop(img, (tr.x, tr.y, tr.w, tr.h))
            if crop is None:
                with self._lock:
                    self._inflight.discard(key)
                continue
            self._pool.submit(self._check, key, crop, ox, oy, s, clip_t, self._epoch)

    def armed(self, camera_id: str, t: float, tracks: list[Any]) -> dict[str, str]:
        ids = {tr.track_id for tr in tracks}
        return {h["track"]: h["type"] for h in self._recent(camera_id, t) if h["track"] in ids}

    def boxes_xywh(self, camera_id: str, t: float, tracks: list[Any] | None = None) -> list[tuple[float, float, float, float]]:
        # SAM boxes come from person crops, so they are already person-bound; `tracks` is unused.
        return [(b[0], b[1], b[2] - b[0], b[3] - b[1]) for b in (h["box"] for h in self._recent(camera_id, t))]

    def latest_hit(self, camera_id: str, track_id: str) -> dict[str, Any] | None:
        with self._lock:
            hits = [h for h in self._hits.get(camera_id.lower(), []) if h["track"] == track_id]
        return hits[-1] if hits else None

    def stats(self) -> dict[str, int]:
        return {"sam_calls": self.calls, "sam_cache_hits": self.cache_hits}

    # ------------------------------------------------------------- internals
    def _recent(self, camera_id: str, t: float) -> list[dict[str, Any]]:
        with self._lock:
            return [h for h in self._hits.get(camera_id.lower(), []) if 0 <= t - h["t"] <= SHOW_S]

    def _check(self, key, crop, ox, oy, s, clip_t, epoch) -> None:
        cam, track = key
        try:
            jpeg = cv2.imencode(".jpg", crop, [cv2.IMWRITE_JPEG_QUALITY, 95])[1].tobytes()
            for concept in CONCEPTS:
                boxes = self._segment(jpeg, concept)
                found = [b for b in boxes if (b[4] or 0) >= MIN_CONF]
                if found:
                    a, b_, c, d, conf = max(found, key=lambda b: b[4] or 0)
                    hit = {"type": "handgun" if concept == "gun" else concept, "conf": conf, "t": clip_t,
                           "track": track, "box": [ox + a / s, oy + b_ / s, ox + c / s, oy + d / s]}
                    with self._lock:
                        if epoch == self._epoch:  # drop answers from before a reset
                            self._hits.setdefault(cam, []).append(hit)
                            self._hits[cam] = self._hits[cam][-50:]
                    activity.pulse("weapons", 1)
                    break
        except Exception as exc:  # noqa: BLE001 — a failed check is just "not seen"; never invent a weapon
            print(f"[sam] check failed: {type(exc).__name__}: {str(exc)[:120]}", flush=True)
        finally:
            with self._lock:
                self._inflight.discard(key)

    def _segment(self, jpeg: bytes, concept: str) -> list:
        digest = hashlib.sha256(jpeg + concept.encode()).hexdigest()
        with self._lock:
            if digest in self._cache:
                self.cache_hits += 1
                return self._cache[digest]
            if self.calls >= MAX_CALLS or os.environ.get("ALLOW_PAID_INFERENCE", "").lower() != "true":
                return []
            self.calls += 1
        with activity.busy("sam"):
            boxes = asyncio.run(_sam_call(jpeg, concept))
        usage_add(MODEL, requests=1, live=1)
        with self._lock:
            self._cache[digest] = boxes
            CACHE.parent.mkdir(parents=True, exist_ok=True)
            CACHE.write_text(json.dumps(self._cache))
        return boxes


async def _sam_call(jpeg: bytes, concept: str) -> list:
    from meta_sam_parser import SegmentationBoxRecord, image_segmentation_format, parse_responses_stream
    from openai import AsyncOpenAI

    cli = AsyncOpenAI(base_url=os.environ.get("META_MODEL_BASE_URL", "https://api.meta.ai/v1"),
                      api_key=os.environ["META_MODEL_API_KEY"], timeout=30.0, max_retries=1)
    stream = await cli.responses.create(
        model=MODEL, stream=True, metadata={"include_confidence": "true"},
        input=[{"type": "message", "role": "user", "content": [
            {"type": "input_text", "text": concept},
            {"type": "input_image", "image_url": "data:image/jpeg;base64," + base64.b64encode(jpeg).decode()}]}])
    result = await parse_responses_stream(stream, image_segmentation_format()).final_result()
    return [[r.left, r.top, r.right, r.bottom, r.confidence] for r in result.records
            if isinstance(r, SegmentationBoxRecord)]


def load_default() -> SamWeapons | None:
    if os.environ.get("META_MODEL_API_KEY") and os.environ.get("CS_WEAPONS", "sam") == "sam":
        return SamWeapons()
    return None
