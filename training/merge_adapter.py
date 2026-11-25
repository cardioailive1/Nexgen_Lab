#!/usr/bin/env python3
"""Merge the NexGen Pro LoRA adapter into the base model and save a plain full model (for vLLM).

    python merge_adapter.py [--adapter DIR] [--out DIR]

Needs ~55 GB free disk and a GPU (or lots of RAM). The base is loaded in bf16, NOT 4-bit: merging into a
4-bit base would bake in quantization error. (Training/eval used nf4, so outputs can differ slightly
from the eval_results you reviewed; spot-check after merging.)
"""
import argparse, os, torch, transformers
from peft import PeftModel
from transformers import AutoProcessor

BASE = os.environ.get("BASE_MODEL", "Qwen/Qwen3.8-27B")
ap = argparse.ArgumentParser()
ap.add_argument("--adapter", default="/workspace/Nexgen_Lab/training/checkpoints/nexgen-pro-v1")
ap.add_argument("--out", default="/workspace/merged/nexgen-pro-v1")
a = ap.parse_args()

model = None
for name in ("AutoModelForImageTextToText", "AutoModelForMultimodalLM", "AutoModelForCausalLM"):
    cls = getattr(transformers, name, None)
    if cls is None:
        continue
    try:
        model = cls.from_pretrained(BASE, torch_dtype=torch.bfloat16, device_map="auto")
        print("loaded base with", name, flush=True)
        break
    except Exception as e:
        print(name, "failed:", repr(e)[:200], flush=True)
if model is None:
    raise SystemExit("Could not load base model.")

model = PeftModel.from_pretrained(model, a.adapter).merge_and_unload()
os.makedirs(a.out, exist_ok=True)
model.save_pretrained(a.out, safe_serialization=True, max_shard_size="5GB")
AutoProcessor.from_pretrained(BASE).save_pretrained(a.out)   # processor + tokenizer + chat template
print("MERGE_DONE ->", a.out, flush=True)
