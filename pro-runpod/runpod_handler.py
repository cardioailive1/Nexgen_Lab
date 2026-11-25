"""RunPod Serverless entrypoint for NexGen Pro v1 (image + text -> text).

Reuses pro-hf-deploy/handler.py (copied to /app/pro_handler.py by the Dockerfile) so there is one
source of truth for prompt format, image handling and generation. The Lab already calls RunPod
endpoints through /runsync with {"input": {system, messages, max_tokens}} and reads
output.content[0].text, which is exactly what this returns.

Environment variables to set on the RunPod endpoint:
  HF_TOKEN      read-only HF token with access to the private adapter repo (store as a RunPod secret)
  ADAPTER_REPO  default nexgen2/nexgen-pro-v1-lora
  HF_HOME       default /runpod-volume/hf (a network volume caches the 52 GB base model between cold starts)
  LOAD_4BIT=1   optional: nf4 like training/eval (~20 GB VRAM, slower)
"""
import os
import sys

import runpod
from huggingface_hub import snapshot_download

sys.path.insert(0, "/app")
from pro_handler import EndpointHandler  # noqa: E402

ADAPTER_REPO = os.environ.get("ADAPTER_REPO", "nexgen2/nexgen-pro-v1-lora")
adapter_dir = snapshot_download(ADAPTER_REPO, token=os.environ.get("HF_TOKEN"),
                                allow_patterns=["adapter_*", "*.json", "*.jinja"])
print(f"Adapter ready at {adapter_dir}; loading base model...", flush=True)
_handler = EndpointHandler(adapter_dir)
print("Model loaded. Serving.", flush=True)


def handler(event):
    return _handler(event.get("input", {}))


runpod.serverless.start({"handler": handler})
