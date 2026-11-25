#!/usr/bin/env python3
"""Always-on HTTP server for NexGen Pro v1 (image + text -> text) on a GPU pod/VM.

Speaks the shape the Lab already uses for non-RunPod URLs:
  POST {url}/v1/chat/completions   {"system": "...", "messages": [...], "max_tokens": 500}
  ->  {"content": [{"type": "text", "text": "..."}], "usage": {...}}
Images go in messages[].content as {"type":"image_url","image_url":{"url":"data:image/jpeg;base64,..."}}.

    export NEXGEN_API_KEY=<long random string>     # required in practice: the proxy URL is public
    uvicorn serve_vision:app --host 0.0.0.0 --port 8000
Reuses pro-hf-deploy/handler.py so prompt format / enable_thinking=false / image limits match the tests.
"""
import hmac
import os
import sys

from fastapi import FastAPI, HTTPException, Request
from starlette.concurrency import run_in_threadpool

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "pro-hf-deploy"))
from handler import EndpointHandler  # noqa: E402

ADAPTER = os.environ.get("NEXGEN_ADAPTER_PATH", "/workspace/Nexgen_Lab/training/checkpoints/nexgen-pro-v1")
API_KEY = os.environ.get("NEXGEN_API_KEY", "")
if not API_KEY:
    print("WARNING: NEXGEN_API_KEY is not set: anyone with the URL can use this GPU.", flush=True)

print(f"Loading base model + adapter from {ADAPTER} ...", flush=True)
_h = EndpointHandler(ADAPTER)
print("Model ready.", flush=True)

app = FastAPI(title="NexGen Pro inference")


def _authorised(header: str) -> bool:
    return not API_KEY or hmac.compare_digest(header or "", f"Bearer {API_KEY}")


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/v1/chat/completions")
async def chat(request: Request):
    if not _authorised(request.headers.get("authorization", "")):
        raise HTTPException(status_code=401, detail="unauthorised")
    body = await request.json()
    out = await run_in_threadpool(_h, body)
    if isinstance(out, dict) and "error" in out:
        raise HTTPException(status_code=400, detail=out["error"])
    return out
