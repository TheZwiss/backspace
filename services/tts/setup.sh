#!/usr/bin/env sh
set -eu
cd "$(dirname "$0")"
"${TTS_PYTHON:-python3}" -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
.venv/bin/python download_models.py
printf '\nStart with: services/tts/.venv/bin/python services/tts/server.py\n'
