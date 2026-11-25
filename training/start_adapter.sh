#!/usr/bin/env bash
# Lab-format adapter in front of vLLM (:8000). Run after start_vllm.sh reports startup complete.
#   bash start_adapter.sh
# Port 8010 (RunPod's nginx already owns 8001). Then expose THIS port to the Lab, e.g.
#   /workspace/cloudflared tunnel --url http://localhost:8010
set -euo pipefail
cd "$(dirname "$0")"
VENV="${VENV:-/workspace/vllm-env}"
PORT="${PORT:-8010}"
pkill -f "uvicorn lab_adapter" 2>/dev/null || true
setsid nohup "$VENV/bin/python" -m uvicorn lab_adapter:app --host 127.0.0.1 --port "$PORT" > /workspace/adapter.log 2>&1 &
sleep 4
if curl -sf "localhost:$PORT/health" >/dev/null; then echo "adapter up on :$PORT"; else echo "ADAPTER FAILED:"; tail -n 8 /workspace/adapter.log; exit 1; fi
