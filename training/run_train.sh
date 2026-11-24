#!/bin/bash
# Unattended NexGen Pro training: retries from the latest checkpoint if the
# run crashes, and (optionally) stops the pod afterwards so an idle GPU is not billed.
#
#   AUTO_STOP=1 setsid nohup bash run_train.sh > /workspace/train.log 2>&1 &
#
# Env: AUTO_STOP=1 -> `runpodctl stop pod` when finished or after giving up.
cd "$(dirname "$0")"
export PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True
OUT="${OUT:-checkpoints/nexgen-pro-v1}"
MAX_TRIES="${MAX_TRIES:-4}"

finish() {
  echo "[run_train] $1 at $(date)"
  if [ "${AUTO_STOP:-0}" = "1" ] && command -v runpodctl >/dev/null 2>&1 && [ -n "$RUNPOD_POD_ID" ]; then
    echo "[run_train] stopping pod $RUNPOD_POD_ID"
    runpodctl stop pod "$RUNPOD_POD_ID"
  fi
  exit "$2"
}

for attempt in $(seq 1 "$MAX_TRIES"); do
  CK=$(ls -d "$OUT"/checkpoint-* 2>/dev/null | sort -V | tail -1)
  if [ -n "$CK" ]; then
    export RESUME_FROM_CHECKPOINT="$CK"
    echo "[run_train] attempt $attempt: resuming from $CK"
  else
    unset RESUME_FROM_CHECKPOINT
    echo "[run_train] attempt $attempt: fresh start"
  fi
  python train_vision_lora.py --config config_pro.yaml \
    --data train_split.jsonl --eval-data eval.jsonl
  rc=$?
  [ $rc -eq 0 ] && finish "finished OK" 0
  echo "[run_train] attempt $attempt failed (exit $rc); retrying in 60s"
  sleep 60
done
finish "gave up after $MAX_TRIES attempts" 1
