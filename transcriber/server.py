"""
Mini-Claw Transcription Server

Lightweight HTTP server that transcribes audio files using faster-whisper.
Designed to run as a companion process alongside the mini-claw Telegram bot.

Usage:
    python transcriber/server.py

Environment:
    TRANSCRIBER_PORT     (default: 3900)
    TRANSCRIBER_MODEL    (default: small)
    TRANSCRIBER_DEVICE   (default: cpu)
    TRANSCRIBER_COMPUTE  (default: int8)
    TRANSCRIBER_LANGUAGE (default: fr)
    TRANSCRIBER_THREADS  (default: 8)
"""

from __future__ import annotations

import json
import logging
import os
import sys
import tempfile
import time
from http.server import HTTPServer, BaseHTTPRequestHandler
from pathlib import Path
from threading import Lock

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

PORT = int(os.environ.get("TRANSCRIBER_PORT", "3900"))
MODEL_SIZE = os.environ.get("TRANSCRIBER_MODEL", "small")
DEVICE = os.environ.get("TRANSCRIBER_DEVICE", "cpu")
COMPUTE_TYPE = os.environ.get("TRANSCRIBER_COMPUTE", "int8")
LANGUAGE = os.environ.get("TRANSCRIBER_LANGUAGE", "fr")
NUM_THREADS = int(os.environ.get("TRANSCRIBER_THREADS", "8"))

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [transcriber] %(levelname)s %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("transcriber")

# Suppress noisy faster-whisper logs
logging.getLogger("faster_whisper").setLevel(logging.WARNING)

# ---------------------------------------------------------------------------
# Model (lazy-loaded, singleton)
# ---------------------------------------------------------------------------

_model = None
_model_lock = Lock()


def get_model():
    """Load the Whisper model on first use (thread-safe)."""
    global _model
    if _model is not None:
        return _model

    with _model_lock:
        if _model is not None:
            return _model

        log.info(f"Loading model '{MODEL_SIZE}' (device={DEVICE}, compute={COMPUTE_TYPE}, threads={NUM_THREADS})...")
        t0 = time.monotonic()

        from faster_whisper import WhisperModel
        _model = WhisperModel(
            MODEL_SIZE,
            device=DEVICE,
            compute_type=COMPUTE_TYPE,
            cpu_threads=NUM_THREADS,
        )

        elapsed = time.monotonic() - t0
        log.info(f"Model loaded in {elapsed:.1f}s")
        return _model


def transcribe_file(audio_path: str, language: str | None = None) -> dict:
    """Transcribe an audio file and return result dict."""
    model = get_model()
    lang = language or LANGUAGE

    t0 = time.monotonic()

    segments, info = model.transcribe(
        audio_path,
        beam_size=5,
        language=lang,
        vad_filter=True,
        vad_parameters=dict(
            min_silence_duration_ms=500,
            speech_pad_ms=200,
        ),
    )

    # Consume generator
    text_parts = []
    for segment in segments:
        text_parts.append(segment.text.strip())

    text = " ".join(text_parts)
    elapsed = time.monotonic() - t0

    return {
        "text": text,
        "language": info.language,
        "language_probability": round(info.language_probability, 3),
        "duration_audio": round(info.duration, 1),
        "duration_processing": round(elapsed, 2),
    }


# ---------------------------------------------------------------------------
# HTTP Handler
# ---------------------------------------------------------------------------

class TranscriberHandler(BaseHTTPRequestHandler):
    """Simple HTTP handler for transcription requests."""

    def log_message(self, format, *args):
        """Override to use our logger."""
        log.info(format % args)

    def do_GET(self):
        """Health check endpoint."""
        if self.path == "/health":
            self._json_response(200, {
                "status": "ok",
                "model": MODEL_SIZE,
                "device": DEVICE,
                "compute_type": COMPUTE_TYPE,
                "language": LANGUAGE,
                "model_loaded": _model is not None,
            })
        else:
            self._json_response(404, {"error": "Not found"})

    def do_POST(self):
        """Transcription endpoint. Accepts audio file as raw body."""
        if self.path != "/transcribe":
            self._json_response(404, {"error": "Not found"})
            return

        content_length = int(self.headers.get("Content-Length", 0))
        if content_length == 0:
            self._json_response(400, {"error": "No audio data"})
            return

        # Optional language override via query param or header
        language = self.headers.get("X-Language", None)

        # Read audio body into temp file
        audio_data = self.rfile.read(content_length)

        # Determine extension from Content-Type
        content_type = self.headers.get("Content-Type", "audio/ogg")
        ext_map = {
            "audio/ogg": ".ogg",
            "audio/mpeg": ".mp3",
            "audio/wav": ".wav",
            "audio/x-wav": ".wav",
            "audio/mp4": ".m4a",
            "application/octet-stream": ".ogg",  # default for Telegram
        }
        ext = ext_map.get(content_type, ".ogg")

        try:
            with tempfile.NamedTemporaryFile(suffix=ext, delete=False) as tmp:
                tmp.write(audio_data)
                tmp_path = tmp.name

            log.info(f"Transcribing {content_length} bytes ({ext})...")
            result = transcribe_file(tmp_path, language)
            log.info(f"Done: {result['duration_processing']}s for {result['duration_audio']}s audio -> {len(result['text'])} chars")

            self._json_response(200, result)

        except Exception as e:
            log.exception("Transcription failed")
            self._json_response(500, {"error": str(e)})

        finally:
            # Cleanup temp file
            try:
                os.unlink(tmp_path)
            except Exception:
                pass

    def _json_response(self, status: int, data: dict):
        """Send a JSON response."""
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    log.info(f"Starting transcription server on port {PORT}")
    log.info(f"Model: {MODEL_SIZE} | Device: {DEVICE} | Compute: {COMPUTE_TYPE} | Language: {LANGUAGE}")

    # Pre-load model at startup
    get_model()

    server = HTTPServer(("127.0.0.1", PORT), TranscriberHandler)
    log.info(f"Server ready at http://127.0.0.1:{PORT}")
    log.info(f"  POST /transcribe  — send audio, get text")
    log.info(f"  GET  /health      — health check")

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        log.info("Shutting down...")
        server.server_close()


if __name__ == "__main__":
    main()
