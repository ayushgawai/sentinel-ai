#!/usr/bin/env sh
# Start Sentinel AI on this Mac: API on :8180, console on :8190. Ctrl+C stops both.
cd "$(dirname "$0")/.."
set -a; . ./.env; set +a
export PYTHONPATH=.
mkdir -p logs
lsof -ti :8180 -sTCP:LISTEN | xargs kill 2>/dev/null
lsof -ti :8190 -sTCP:LISTEN | xargs kill 2>/dev/null
.venv/bin/python -m http.server 8190 --bind 127.0.0.1 --directory web > logs/web.log 2>&1 &
WEB=$!
trap 'kill $WEB 2>/dev/null' EXIT INT TERM
URL="http://127.0.0.1:8190/"
echo "Sentinel AI: $URL"
(sleep 6 && open "$URL") &
.venv/bin/python -m services.api --host 127.0.0.1 --port 8180 2>&1 | tee logs/api.log
