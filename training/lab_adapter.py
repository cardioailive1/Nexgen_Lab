"""Translate the Lab's inference format <-> vLLM's OpenAI format.

Lab sends   POST /v1/chat/completions  {system, messages, max_tokens}      (Authorization: Bearer <key>)
Lab expects {"content":[{"type":"text","text":...}], "usage":{"input_tokens","output_tokens"}}
vLLM speaks OpenAI chat format on VLLM_URL (default http://127.0.0.1:8000) with the same API key.

    uvicorn lab_adapter:app --host 127.0.0.1 --port 8010

The adapter holds no secrets: it forwards the caller's Authorization header to vLLM, which does the key check.
Messages may be plain strings or content-block lists (Lab/Anthropic style text + base64 image blocks, or OpenAI
image_url blocks).
"""
import json, os, urllib.error, urllib.request
from fastapi import FastAPI, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse

VLLM_URL = os.environ.get("VLLM_URL", "http://127.0.0.1:8000").rstrip("/")
MODEL = os.environ.get("VLLM_MODEL", "nexgen-pro-v1")
TIMEOUT = int(os.environ.get("ADAPTER_TIMEOUT", "300"))
app = FastAPI()


def _block(b):
    if isinstance(b, str):
        return {"type": "text", "text": b}
    t = b.get("type")
    if t == "text":
        return {"type": "text", "text": b.get("text", "")}
    if t == "image_url":
        return b
    if t == "image":                      # Anthropic-style base64 block
        src = b.get("source") or {}
        if src.get("type") == "base64":
            return {"type": "image_url", "image_url": {"url": f"data:{src.get('media_type', 'image/jpeg')};base64,{src['data']}"}}
        if isinstance(b.get("image"), str):  # {"type":"image","image":"<base64>"}
            return {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64," + b["image"]}}
        raise ValueError("Unsupported image block (send base64).")
    raise ValueError(f"Unsupported content block type: {t}")


def to_openai(body):
    msgs = []
    if body.get("system"):
        msgs.append({"role": "system", "content": body["system"]})
    for m in body.get("messages", []):
        c = m.get("content", "")
        msgs.append({"role": m["role"], "content": c if isinstance(c, str) else [_block(b) for b in c]})
    out = {"model": MODEL, "messages": msgs, "max_tokens": int(body.get("max_tokens", 500))}
    for k in ("temperature", "top_p"):
        if k in body:
            out[k] = body[k]
    return out


def _call(payload, auth):
    req = urllib.request.Request(f"{VLLM_URL}/v1/chat/completions", json.dumps(payload).encode(), method="POST",
                                 headers={"Content-Type": "application/json", **({"Authorization": auth} if auth else {})})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            return r.status, json.load(r)
    except urllib.error.HTTPError as e:
        try:
            detail = json.load(e)
        except Exception:
            detail = {}
        msg = detail.get("error") if isinstance(detail.get("error"), str) else (detail.get("error") or {}).get("message") or detail.get("message") or f"HTTP {e.code}"
        return e.code, {"error": msg}
    except Exception as e:
        return 502, {"error": f"inference server unreachable: {e}"}


@app.get("/health")
def health():
    return {"ok": True}


@app.post("/v1/chat/completions")
async def chat(request: Request):
    try:
        payload = to_openai(await request.json())
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=400)
    status, data = await run_in_threadpool(_call, payload, request.headers.get("authorization"))
    if status != 200:
        return JSONResponse({"error": data.get("error", f"HTTP {status}")}, status_code=status)
    text = (data.get("choices") or [{}])[0].get("message", {}).get("content") or ""
    u = data.get("usage") or {}
    return {"content": [{"type": "text", "text": text}],
            "usage": {"input_tokens": u.get("prompt_tokens", 0), "output_tokens": u.get("completion_tokens", 0)},
            "model": MODEL}
