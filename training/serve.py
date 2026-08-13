#!/usr/bin/env python3
"""
NexGen — Inference Server
============================
Serves the fine-tuned NexGen checkpoint (base model + LoRA adapter) behind
a small FastAPI server with a streaming chat endpoint. This is what the
website's playground would call instead of any third-party AI API.

This holds model weights in server memory/VRAM only — no API keys, no
client-side credentials, nothing exposed to the browser. Run this on your
own GPU instance (cloud or on-prem) and point the frontend at it.

Usage:
    uvicorn serve:app --host 0.0.0.0 --port 8000

Requires: fastapi, uvicorn, torch, transformers, peft, sse-starlette
"""

import os
import threading
from typing import List, Optional

import torch
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from peft import PeftModel
from pydantic import BaseModel
from sse_starlette.sse import EventSourceResponse
from transformers import AutoModelForCausalLM, AutoTokenizer, TextIteratorStreamer

BASE_MODEL = os.environ.get("NEXGEN_BASE_MODEL", "meta-llama/Meta-Llama-3.1-8B-Instruct")
ADAPTER_PATH = os.environ.get("NEXGEN_ADAPTER_PATH", "checkpoints/nexgen-v1")
MAX_NEW_TOKENS = int(os.environ.get("NEXGEN_MAX_NEW_TOKENS", "1024"))

app = FastAPI(title="NexGen Inference Server")

# Lock this down to your actual frontend origin(s) in production — "*" is
# fine for local testing only.
app.add_middleware(
    CORSMiddleware,
    allow_origins=os.environ.get("NEXGEN_ALLOWED_ORIGINS", "*").split(","),
    allow_methods=["POST"],
    allow_headers=["*"],
)

_tokenizer = None
_model = None


def load_model():
    global _tokenizer, _model
    print(f"Loading base model: {BASE_MODEL}")
    _tokenizer = AutoTokenizer.from_pretrained(BASE_MODEL)
    if _tokenizer.pad_token is None:
        _tokenizer.pad_token = _tokenizer.eos_token

    base = AutoModelForCausalLM.from_pretrained(
        BASE_MODEL, torch_dtype=torch.bfloat16, device_map="auto"
    )

    if os.path.exists(ADAPTER_PATH):
        print(f"Loading LoRA adapter: {ADAPTER_PATH}")
        _model = PeftModel.from_pretrained(base, ADAPTER_PATH)
    else:
        print("No adapter found — serving the base model unmodified.")
        _model = base

    _model.eval()
    print("Model loaded.")


class Message(BaseModel):
    role: str
    content: str


class ChatRequest(BaseModel):
    messages: List[Message]
    system: Optional[str] = None
    max_new_tokens: Optional[int] = None
    temperature: float = 0.7


@app.on_event("startup")
def startup():
    load_model()


@app.get("/health")
def health():
    return {"status": "ok", "model_loaded": _model is not None}


@app.post("/v1/chat")
async def chat(req: ChatRequest):
    """Non-streaming completion — returns the full response."""
    if _model is None:
        raise HTTPException(status_code=503, detail="Model not loaded yet")

    chat_messages = []
    if req.system:
        chat_messages.append({"role": "system", "content": req.system})
    chat_messages.extend([m.model_dump() for m in req.messages])

    prompt = _tokenizer.apply_chat_template(
        chat_messages, tokenize=False, add_generation_prompt=True
    )
    inputs = _tokenizer(prompt, return_tensors="pt").to(_model.device)

    with torch.no_grad():
        output_ids = _model.generate(
            **inputs,
            max_new_tokens=req.max_new_tokens or MAX_NEW_TOKENS,
            temperature=req.temperature,
            do_sample=req.temperature > 0,
        )

    new_tokens = output_ids[0][inputs["input_ids"].shape[1]:]
    text = _tokenizer.decode(new_tokens, skip_special_tokens=True)
    return {"content": text}


@app.post("/v1/chat/stream")
async def chat_stream(req: ChatRequest):
    """Streaming completion (SSE) — for the playground's live-typing UI."""
    if _model is None:
        raise HTTPException(status_code=503, detail="Model not loaded yet")

    chat_messages = []
    if req.system:
        chat_messages.append({"role": "system", "content": req.system})
    chat_messages.extend([m.model_dump() for m in req.messages])

    prompt = _tokenizer.apply_chat_template(
        chat_messages, tokenize=False, add_generation_prompt=True
    )
    inputs = _tokenizer(prompt, return_tensors="pt").to(_model.device)

    streamer = TextIteratorStreamer(_tokenizer, skip_prompt=True, skip_special_tokens=True)
    generation_kwargs = dict(
        **inputs,
        max_new_tokens=req.max_new_tokens or MAX_NEW_TOKENS,
        temperature=req.temperature,
        do_sample=req.temperature > 0,
        streamer=streamer,
    )

    thread = threading.Thread(target=_model.generate, kwargs=generation_kwargs)
    thread.start()

    async def event_generator():
        for token_text in streamer:
            yield {"event": "delta", "data": token_text}
        yield {"event": "done", "data": ""}

    return EventSourceResponse(event_generator())
