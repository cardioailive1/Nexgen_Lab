#!/usr/bin/env bash
# Serve the MERGED model with vLLM (OpenAI-compatible) on port 8000.
#   export NEXGEN_API_KEY=...   (read -s -p 'key: ' NEXGEN_API_KEY; export NEXGEN_API_KEY)
#   bash merge_adapter.py first (python merge_adapter.py), then: bash start_vllm.sh
# vLLM lives in its own venv on /workspace (survives pod restarts; keeps training env untouched).
# Stop serve_vision.py first -- both want the whole GPU.
set -euo pipefail
: "${NEXGEN_API_KEY:?set NEXGEN_API_KEY first}"
MODEL="${MODEL:-/workspace/merged/nexgen-pro-v1}"
VENV=/workspace/vllm-env
if [ ! -x "$VENV/bin/vllm" ]; then
  python -m venv "$VENV"
  "$VENV/bin/pip" install -U pip
  "$VENV/bin/pip" install "vllm>=0.17.0" "transformers>=5.8.0"
fi
pkill -f "vllm serve" 2>/dev/null || true
setsid nohup "$VENV/bin/vllm" serve "$MODEL" \
  --served-model-name nexgen-pro-v1 \
  --host 0.0.0.0 --port 8000 \
  --api-key "$NEXGEN_API_KEY" \
  --max-model-len 8192 \
  --gpu-memory-utilization 0.90 \
  --limit-mm-per-prompt '{"image": 4}' \
  --default-chat-template-kwargs '{"enable_thinking": false}' \
  > /workspace/vllm.log 2>&1 &
echo "started; watch: tail -c 600 /workspace/vllm.log | tr '\r' '\n'"
echo "ready when log shows 'Application startup complete'; test: curl -s localhost:8000/v1/models -H \"Authorization: Bearer \$NEXGEN_API_KEY\""
