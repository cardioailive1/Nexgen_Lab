#!/usr/bin/env bash
# Start the inference server in the background. Needs NEXGEN_API_KEY in the environment.
cd /workspace/Nexgen_Lab/training
export HF_HOME=/workspace/hf
[ -z "$NEXGEN_API_KEY" ] && { echo "Set NEXGEN_API_KEY first"; exit 1; }
setsid nohup uvicorn serve_vision:app --host 0.0.0.0 --port 8000 > /workspace/server.log 2>&1 &
echo "started; watch: tail -c 300 /workspace/server.log"
