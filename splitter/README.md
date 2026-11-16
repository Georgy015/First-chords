# Stem Splitter

A free, local song splitter. Drop in a song and get separate vocals, drums, bass,
guitar, piano and "other" tracks, with a mixer to mute, solo and rebalance them.

Separation is done by [Demucs](https://github.com/adefossez/demucs) (open source, MIT),
running on your own computer. Nothing is uploaded anywhere and there are no limits.

## Setup (once)

You need Python 3.9 or newer.

```bash
cd splitter
python -m venv .venv
```

Activate it: `source .venv/bin/activate` on macOS/Linux, `.venv\Scripts\activate` on Windows. Then:

```bash
pip install -r requirements.txt
```

This downloads PyTorch, so it takes a few minutes. If you have an NVIDIA GPU, install the
CUDA build of PyTorch first (see pytorch.org) and splitting gets many times faster.

## Run

```bash
python server.py
```

Open http://127.0.0.1:8765. The first split downloads the model (about 80 MB per model), once.

## What it does

- Accepts any format ffmpeg can read (mp3, wav, flac, m4a, ogg, video files...).
- **6 stems** (vocals, drums, bass, guitar, piano, other) or **4 stems** (vocals, drums, bass, other).
  The 4-stem model is a little cleaner; in the 6-stem model piano is the weakest stem.
- Per stem: mute, solo, volume (double-click the slider to reset), download as WAV.
- Click a waveform to jump; drag to select a section and loop it.
- **Export mix** saves what you currently hear (for example everything minus guitar) as one WAV.
- Split songs are kept in `splitter/data/` and listed under "Your songs".

Keys: Space play/pause, L loop, ←/→ skip 5 seconds, Home back to start.

## Speed

On a GPU or Apple Silicon a song takes well under a minute. On CPU only, expect roughly
half the song's length to a few times its length, depending on the machine.

## Options

- `python server.py --port 9000` to use another port.
- `python server.py --host 0.0.0.0` to reach it from other devices on your network.
- `SPLITTER_DEVICE=cpu` to force a device (`cpu`, `cuda`, `mps`).
- `SPLITTER_DATA=/some/folder` to keep songs elsewhere.
