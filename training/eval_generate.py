#!/usr/bin/env python3
"""Qualitative test of a trained NexGen Pro adapter on held-out images.

Loads the base model (4-bit, same as training) + the LoRA adapter, then for a
domain-spread sample of eval.jsonl generates a caption with the TUNED model
and (optionally) the untouched BASE model, and writes a side-by-side HTML
page: image | reference caption | base output | tuned output.

    cd /workspace/Nexgen_Lab/training
    export HF_HOME=/workspace/hf
    python eval_generate.py --adapter checkpoints/nexgen-pro-v1 \
        --data eval.jsonl --images-root . --n 24

Outputs eval_results.html and eval_results.jsonl in the current directory.
Use --no-base to skip the base-model column (about half the time).
"""
import argparse, base64, collections, html, io, json, os, random, time

import torch
from peft import PeftModel
from transformers import AutoProcessor, BitsAndBytesConfig
import transformers

from train_vision_lora import load_example_images


def load_model(base_model):
    quant = BitsAndBytesConfig(
        load_in_4bit=True, bnb_4bit_quant_type="nf4",
        bnb_4bit_compute_dtype=torch.bfloat16, bnb_4bit_use_double_quant=True)
    last = None
    for name in ("AutoModelForImageTextToText", "AutoModelForMultimodalLM", "AutoModelForCausalLM"):
        cls = getattr(transformers, name, None)
        if cls is None:
            continue
        try:
            m = cls.from_pretrained(base_model, quantization_config=quant,
                                    device_map="auto", torch_dtype=torch.bfloat16)
            print(f"Loaded {base_model} with {name}")
            return m
        except Exception as e:
            last = e
            print(f"{name} failed: {e.__class__.__name__}: {str(e)[:200]}")
    raise RuntimeError("No loader worked") from last


def pick_examples(recs, n, seed):
    """Spread the sample across domains (round-robin), seeded."""
    rng = random.Random(seed)
    by_dom = collections.defaultdict(list)
    for r in recs:
        by_dom[r.get("domain", "unknown")].append(r)
    for v in by_dom.values():
        rng.shuffle(v)
    doms = sorted(by_dom)
    rng.shuffle(doms)
    out = []
    while len(out) < n and any(by_dom.values()):
        for d in doms:
            if by_dom[d] and len(out) < n:
                out.append(by_dom[d].pop())
    return out


def prompt_messages(rec):
    msgs = []
    if rec.get("system"):
        msgs.append({"role": "system", "content": rec["system"]})
    msgs.extend(m for m in rec["messages"] if m["role"] != "assistant")
    return msgs


def reference(rec):
    for m in reversed(rec["messages"]):
        if m["role"] == "assistant":
            c = m["content"]
            return c if isinstance(c, str) else " ".join(b.get("text", "") for b in c)
    return ""


@torch.no_grad()
def generate(model, processor, rec, images_root, max_pixels, max_new, adapter_on):
    text = processor.apply_chat_template(prompt_messages(rec), tokenize=False,
                                         add_generation_prompt=True)
    images = load_example_images(rec, images_root, max_pixels)
    inputs = processor(text=[text], images=[images], return_tensors="pt").to(model.device)
    kw = dict(max_new_tokens=max_new, do_sample=False)
    if adapter_on:
        out = model.generate(**inputs, **kw)
    else:
        with model.disable_adapter():
            out = model.generate(**inputs, **kw)
    new = out[0][inputs["input_ids"].shape[1]:]
    return processor.tokenizer.decode(new, skip_special_tokens=True).strip()


def thumb_b64(rec, images_root, max_pixels):
    imgs = load_example_images(rec, images_root, max_pixels)
    if not imgs:
        return ""
    im = imgs[0].convert("RGB")
    im.thumbnail((360, 360))
    buf = io.BytesIO()
    im.save(buf, format="JPEG", quality=80)
    return base64.b64encode(buf.getvalue()).decode()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--adapter", default="checkpoints/nexgen-pro-v1")
    ap.add_argument("--base-model", default="Qwen/Qwen3.8-27B")
    ap.add_argument("--data", default="eval.jsonl")
    ap.add_argument("--images-root", default=".")
    ap.add_argument("--n", type=int, default=24)
    ap.add_argument("--max-new-tokens", type=int, default=250)
    ap.add_argument("--max-image-pixels", type=int, default=1400000)
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--no-base", action="store_true")
    ap.add_argument("--out", default="eval_results")
    a = ap.parse_args()

    recs = [json.loads(l) for l in open(a.data) if l.strip()]
    sample = pick_examples(recs, a.n, a.seed)
    print(f"{len(sample)} examples across {len({r.get('domain') for r in sample})} domains")

    processor = AutoProcessor.from_pretrained(a.base_model)
    model = PeftModel.from_pretrained(load_model(a.base_model), a.adapter)
    model.eval()

    rows = []
    t0 = time.time()
    for i, rec in enumerate(sample, 1):
        row = {"id": rec.get("id"), "domain": rec.get("domain"),
               "reference": reference(rec),
               "tuned": generate(model, processor, rec, a.images_root, a.max_image_pixels, a.max_new_tokens, True)}
        if not a.no_base:
            row["base"] = generate(model, processor, rec, a.images_root, a.max_image_pixels, a.max_new_tokens, False)
        row["img"] = thumb_b64(rec, a.images_root, a.max_image_pixels)
        rows.append(row)
        print(f"[{i}/{len(sample)}] {row['domain']}  ({time.time() - t0:.0f}s)", flush=True)

    with open(a.out + ".jsonl", "w") as f:
        for r in rows:
            f.write(json.dumps({k: v for k, v in r.items() if k != "img"}) + "\n")

    cols = ["Image", "Reference (human-reviewed)"] + ([] if a.no_base else ["Base model"]) + ["NexGen Pro (tuned)"]
    parts = ["<html><head><meta charset='utf-8'><style>body{font:14px sans-serif;margin:16px}"
             "table{border-collapse:collapse;width:100%}td,th{border:1px solid #ccc;padding:8px;vertical-align:top}"
             "th{background:#f3f3f3}.d{font-weight:bold;color:#555}</style></head><body>"
             f"<h2>NexGen Pro: {a.adapter} on {len(rows)} held-out images</h2><table><tr>"
             + "".join(f"<th>{c}</th>" for c in cols) + "</tr>"]
    for r in rows:
        cells = [f"<td><img src='data:image/jpeg;base64,{r['img']}'><div class='d'>{html.escape(str(r['domain']))}</div></td>",
                 f"<td>{html.escape(r['reference'])}</td>"]
        if not a.no_base:
            cells.append(f"<td>{html.escape(r['base'])}</td>")
        cells.append(f"<td>{html.escape(r['tuned'])}</td>")
        parts.append("<tr>" + "".join(cells) + "</tr>")
    parts.append("</table></body></html>")
    with open(a.out + ".html", "w") as f:
        f.write("".join(parts))
    print(f"Done in {time.time() - t0:.0f}s. Wrote {a.out}.html and {a.out}.jsonl")


if __name__ == "__main__":
    main()
