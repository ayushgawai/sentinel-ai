#!/usr/bin/env python3
"""Local ASR serve for services/voice/parakeet.py's ParakeetClient contract.

  POST /transcribe   body: raw PCM16 mono 16kHz bytes (octet-stream)
                      reply: plain UTF-8 text transcript

Run with the isolated venv (never services/vision/.venv):

  services/voice/.venv/bin/python scripts/serve_parakeet.py --port 8091

Then set CS_PARAKEET_URL=http://127.0.0.1:8091/transcribe in .env.

Model: faster-whisper `base.en` (CTranslate2, int8, CPU). It implements the same
`transcribe(pcm16) -> str` contract as an NVIDIA NeMo Parakeet server, so either can sit
behind CS_PARAKEET_URL. CPU keeps the speech service off the vision process's GPU.
"""

from __future__ import annotations

import argparse
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np

_model = None
_MODEL_NAME = "base.en"


def _load_model():
    global _model
    if _model is not None:
        return _model
    from faster_whisper import WhisperModel

    t0 = time.time()
    _model = WhisperModel(_MODEL_NAME, device="cpu", compute_type="int8")
    print(f"[parakeet] {_MODEL_NAME} loaded in {time.time() - t0:.1f}s", flush=True)
    return _model


def transcribe_pcm16_16k(pcm16: bytes) -> str:
    if not pcm16:
        return ""
    model = _load_model()
    audio_i16 = np.frombuffer(pcm16, dtype="<i2")
    if audio_i16.size == 0:
        return ""
    audio_f32 = audio_i16.astype(np.float32) / 32768.0
    segments, _info = model.transcribe(audio_f32, language="en", beam_size=1)
    return " ".join(s.text.strip() for s in segments).strip()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        print(f"[parakeet] {self.address_string()} {fmt % args}", flush=True)

    def do_POST(self):
        if self.path.rstrip("/") != "/transcribe":
            self.send_response(404)
            self.end_headers()
            return
        length = int(self.headers.get("Content-Length", "0"))
        pcm16 = self.rfile.read(length) if length else b""
        t0 = time.time()
        try:
            text = transcribe_pcm16_16k(pcm16)
        except Exception as exc:  # noqa: BLE001 — never 500 the whole call
            print(f"[parakeet] transcribe failed: {exc}", flush=True)
            self.send_response(500)
            self.end_headers()
            return
        dt = time.time() - t0
        print(f"[parakeet] {len(pcm16)} bytes -> '{text[:80]}' in {dt:.2f}s", flush=True)
        body = text.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.rstrip("/") == "/health":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"ok":true,"service":"parakeet","backend":"faster-whisper"}')
            return
        self.send_response(404)
        self.end_headers()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8091)
    args = ap.parse_args()

    _load_model()  # pre-warm, matches the Kokoro server

    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"[parakeet] serving on http://{args.host}:{args.port}/transcribe", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
