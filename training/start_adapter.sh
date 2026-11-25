#!/usr/bin/env bash
# Lab-format adapter on :8001 in front of vLLM (:8000). Run after start_vllm.sh reports startup complete.
#   bash start_adapter.sh
# Then expose :8001 (NOT :8000) to the Lab, e.g.  /workspace/cloudflared tunnel --url http://localhost:8001
set -euo pipefail
cd "$(dirname "$0")"
VENV="${VENV:-/workspace/vllm-env}"
pkill -f "uvicorn lab_adapter" 2>/dev/null || true
setsid nohup "$VENV/bin/python" -m uvicorn lab_adapter:app --host 127.0.0.1 --port 8001 > /workspace/adapter.log 2>&1 &
sleep 3
curl -s localhost:8001/health && echo " <- adapter up"
