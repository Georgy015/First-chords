#!/bin/bash
cd "$(dirname "$0")"

if ! command -v python3 >/dev/null; then
  echo "Python was not found. Install it from https://www.python.org/downloads/ and open this file again."
  read -r -p "Press Enter to close."
  exit 1
fi

if [ ! -f .venv/installed.txt ]; then
  echo "First run: setting things up. This takes several minutes and only happens once."
  python3 -m venv .venv && .venv/bin/python -m pip install -r requirements.txt && echo ok > .venv/installed.txt
  if [ ! -f .venv/installed.txt ]; then
    echo "Setup did not finish. Copy the messages above and send them to whoever is helping you."
    read -r -p "Press Enter to close."
    exit 1
  fi
fi

echo
echo "Starting Stem Splitter. Keep this window open while you use it. Close it to stop."
.venv/bin/python server.py --open
