#!/usr/bin/env python3
"""Stem Splitter: a local web app that splits songs into instruments with Demucs.

Run `python server.py` and open http://127.0.0.1:8765 in a browser.
Everything runs on this machine; no audio leaves it.
"""
import argparse
import json
import os
import queue
import re
import shutil
import subprocess
import threading
import time
import uuid
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, quote, unquote, urlparse

ROOT = Path(__file__).resolve().parent
STATIC = ROOT / "static"
DATA = Path(os.environ.get("SPLITTER_DATA", ROOT / "data"))

MODELS = {
    "6": "htdemucs_6s",  # vocals, drums, bass, guitar, piano, other
    "4": "htdemucs",     # vocals, drums, bass, other
}
STEM_ORDER = ["vocals", "drums", "bass", "guitar", "piano", "other"]
MAX_UPLOAD = 1024 * 1024 * 1024  # 1 GB
ID_RE = re.compile(r"^[0-9a-f]{12}$")
CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".wav": "audio/wav",
}

songs = {}                 # id -> metadata dict
songs_lock = threading.Lock()
jobs = queue.Queue()
allowed_hosts = None       # set in main(); None disables the check


# ---------------------------------------------------------------- storage

def song_dir(song_id):
    return DATA / song_id


def save_meta(song):
    path = song_dir(song["id"]) / "meta.json"
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(song))
    tmp.replace(path)


def update(song, **changes):
    with songs_lock:
        song.update(changes)
        if "progress" not in changes or len(changes) > 1:
            save_meta(song)


def find_source(song_id):
    return next(iter(song_dir(song_id).glob("source.*")), None)


def load_library():
    """Read saved songs from disk and re-queue any that were interrupted."""
    DATA.mkdir(parents=True, exist_ok=True)
    pending = []
    for meta in DATA.glob("*/meta.json"):
        try:
            song = json.loads(meta.read_text())
        except (OSError, ValueError):
            continue
        if not ID_RE.match(song.get("id", "")):
            continue
        if song["status"] in ("queued", "processing"):
            if find_source(song["id"]):
                song.update(status="queued", progress=0)
                pending.append(song)
            else:
                song.update(status="error", error="Interrupted. Please upload it again.")
        songs[song["id"]] = song
    for song in sorted(pending, key=lambda s: s["created"]):
        jobs.put(song["id"])


# ------------------------------------------------------------- separation

def ffmpeg_exe():
    exe = shutil.which("ffmpeg")
    if exe:
        return exe
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        raise RuntimeError("ffmpeg not found. Install ffmpeg or `pip install imageio-ffmpeg`.")


def decode_audio(path, samplerate, channels):
    """Decode any audio/video file to a float32 tensor of shape (channels, samples)."""
    import numpy as np
    import torch
    cmd = [ffmpeg_exe(), "-v", "error", "-nostdin", "-i", str(path), "-vn", "-map", "0:a:0",
           "-f", "f32le", "-acodec", "pcm_f32le", "-ac", str(channels), "-ar", str(samplerate), "-"]
    proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if proc.returncode != 0 or len(proc.stdout) < 4 * channels * samplerate // 10:
        detail = proc.stderr.decode(errors="replace").strip().splitlines()
        raise RuntimeError("Couldn't read this file as audio." + (f" ({detail[-1]})" if detail else ""))
    data = np.frombuffer(proc.stdout, dtype=np.float32)
    data = data[: len(data) // channels * channels].reshape(-1, channels).T
    return torch.from_numpy(data.copy())


def write_wav(path, audio, samplerate):
    """Write a float tensor (channels, samples) as 16-bit PCM."""
    pcm = (audio.clamp(-1, 1) * 32767).round().short().T.contiguous().numpy()
    with wave.open(str(path), "wb") as out:
        out.setnchannels(audio.shape[0])
        out.setsampwidth(2)
        out.setframerate(samplerate)
        out.writeframes(pcm.tobytes())


_model_cache = {}


def get_model(name):
    if name not in _model_cache:
        if os.environ.get("SPLITTER_TEST_MODEL"):
            # Untrained network, for exercising the pipeline without downloading weights.
            from demucs.htdemucs import HTDemucs
            sources = [s for s in STEM_ORDER if name == "htdemucs_6s" or s not in ("guitar", "piano")]
            model = HTDemucs(sources=sources)
        else:
            from demucs.pretrained import get_model as load
            model = load(name)
        model.eval()
        _model_cache.clear()  # keep one model in memory at a time
        _model_cache[name] = model
    return _model_cache[name]


def pick_device():
    import torch
    forced = os.environ.get("SPLITTER_DEVICE")
    if forced:
        return forced
    if torch.cuda.is_available():
        return "cuda"
    if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
        return "mps"
    return "cpu"


def separate(song):
    import torch
    from demucs.apply import apply_model

    update(song, status="processing", progress=0, stage="Loading model")
    model = get_model(MODELS[song["model"]])
    source = find_source(song["id"])
    mix = decode_audio(source, model.samplerate, model.audio_channels)
    duration = mix.shape[1] / model.samplerate
    update(song, duration=round(duration, 2), stage="Separating")

    def on_progress(info):
        # Called at the start and end of every ~8 second segment.
        done = info["model_idx_in_bag"] + info["segment_offset"] / mix.shape[1]
        update(song, progress=round(min(0.99, done / info["models"]), 3))

    ref = mix.mean(0)
    mean, std = ref.mean(), ref.std() + 1e-8
    batch = ((mix - mean) / std)[None]

    def run(device):
        with torch.no_grad():
            return apply_model(model, batch, device=device, split=True, overlap=0.25,
                               shifts=1, callback=on_progress)[0]

    device = pick_device()
    try:
        out = run(device)
    except Exception:
        if device == "cpu":
            raise
        print(f"[splitter] {device} failed, retrying on CPU")
        out = run("cpu")
    out = out.cpu() * std + mean

    update(song, stage="Saving stems", progress=0.99)
    stems = []
    for name in STEM_ORDER:
        if name in model.sources:
            write_wav(song_dir(song["id"]) / f"{name}.wav", out[model.sources.index(name)], model.samplerate)
            stems.append(name)
    source.unlink(missing_ok=True)
    update(song, status="done", progress=1, stems=stems, stage="")


def worker():
    while True:
        song_id = jobs.get()
        song = songs.get(song_id)
        if not song or song["status"] != "queued":
            continue
        started = time.time()
        try:
            separate(song)
            print(f"[splitter] {song['title']!r} done in {time.time() - started:.0f}s")
        except Exception as exc:
            import traceback
            traceback.print_exc()
            if song_id in songs:
                update(song, status="error", error=str(exc) or exc.__class__.__name__, stage="")


# ------------------------------------------------------------------- http

class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        pass

    def send_json(self, payload, status=200):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def fail(self, status, message):
        self.close_connection = True
        self.send_json({"error": message}, status)

    def send_file(self, path, download_name=None):
        size = path.stat().st_size
        self.send_response(200)
        self.send_header("Content-Type", CONTENT_TYPES.get(path.suffix, "application/octet-stream"))
        self.send_header("Content-Length", str(size))
        self.send_header("Cache-Control", "no-cache")
        if download_name:
            self.send_header("Content-Disposition", f"attachment; filename*=UTF-8''{quote(download_name)}")
        self.end_headers()
        with path.open("rb") as f:
            shutil.copyfileobj(f, self.wfile, 1 << 20)

    def host_ok(self):
        if allowed_hosts is None:
            return True
        host = (self.headers.get("Host") or "").rsplit(":", 1)[0]
        return host in allowed_hosts

    def route(self):
        if not self.host_ok():
            return self.fail(403, "Forbidden host")
        url = urlparse(self.path)
        parts = [unquote(p) for p in url.path.split("/") if p]
        query = parse_qs(url.query)
        method = self.command

        if method == "GET" and not parts:
            return self.send_file(STATIC / "index.html")
        if method == "GET" and len(parts) == 2 and parts[0] == "static":
            path = STATIC / parts[1]
            if path.parent == STATIC and path.is_file():
                return self.send_file(path)
            return self.fail(404, "Not found")

        if parts[:2] == ["api", "songs"]:
            if len(parts) == 2 and method == "GET":
                with songs_lock:
                    listing = sorted(songs.values(), key=lambda s: s["created"], reverse=True)
                    return self.send_json({"songs": listing})
            if len(parts) == 2 and method == "POST":
                return self.upload(query)
            if len(parts) == 3 and ID_RE.match(parts[2]) and parts[2] in songs:
                if method == "DELETE":
                    return self.delete(parts[2])
            return self.fail(404, "Not found")

        if method == "GET" and len(parts) == 3 and parts[0] == "media":
            song = songs.get(parts[1]) if ID_RE.match(parts[1]) else None
            stem = parts[2].removesuffix(".wav")
            if song and song["status"] == "done" and stem in song["stems"]:
                name = f"{song['title']} - {stem}.wav" if "download" in query else None
                return self.send_file(song_dir(song["id"]) / f"{stem}.wav", name)
            return self.fail(404, "Not found")

        self.fail(404, "Not found")

    def upload(self, query):
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return self.fail(400, "Empty upload")
        if length > MAX_UPLOAD:
            return self.fail(413, "File is too large")
        filename = Path(query.get("name", ["song"])[0]).name or "song"
        model = query.get("model", ["6"])[0]
        if model not in MODELS:
            return self.fail(400, "Unknown model")
        ext = re.sub(r"[^a-z0-9]", "", Path(filename).suffix.lower())[:8] or "bin"

        song_id = uuid.uuid4().hex[:12]
        song_dir(song_id).mkdir(parents=True)
        remaining = length
        with (song_dir(song_id) / f"source.{ext}").open("wb") as out:
            while remaining:
                chunk = self.rfile.read(min(remaining, 1 << 20))
                if not chunk:
                    shutil.rmtree(song_dir(song_id), ignore_errors=True)
                    return self.fail(400, "Upload interrupted")
                out.write(chunk)
                remaining -= len(chunk)

        song = {"id": song_id, "title": Path(filename).stem[:200] or "Untitled", "model": model,
                "status": "queued", "progress": 0, "stage": "", "stems": [], "duration": 0,
                "created": time.time()}
        with songs_lock:
            songs[song_id] = song
            save_meta(song)
        jobs.put(song_id)
        self.send_json(song, 201)

    def delete(self, song_id):
        with songs_lock:
            song = songs[song_id]
            if song["status"] == "processing":
                return self.fail(409, "This song is being split right now. Delete it when it finishes.")
            del songs[song_id]
        shutil.rmtree(song_dir(song_id), ignore_errors=True)
        self.send_json({"ok": True})

    def handle_one(self):
        try:
            self.route()
        except (BrokenPipeError, ConnectionResetError):
            self.close_connection = True

    do_GET = do_POST = do_DELETE = handle_one


def main():
    global allowed_hosts
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--host", default="127.0.0.1",
                        help="address to listen on (use 0.0.0.0 to reach it from other devices)")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--open", action="store_true", help="open the app in your browser")
    args = parser.parse_args()
    if args.host in ("127.0.0.1", "localhost", "::1"):
        allowed_hosts = {"127.0.0.1", "localhost", "[::1]"}

    import demucs  # noqa: F401  fail early with a clear error if dependencies are missing
    ffmpeg_exe()
    load_library()
    threading.Thread(target=worker, daemon=True).start()
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"Stem Splitter running at http://{args.host}:{args.port}  (device: {pick_device()})")
    if args.open:
        import webbrowser
        local = "127.0.0.1" if args.host in ("0.0.0.0", "::") else args.host
        threading.Timer(0.5, webbrowser.open, [f"http://{local}:{args.port}"]).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
