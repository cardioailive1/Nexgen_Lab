#!/usr/bin/env python3
"""Interactive test UI for NexGen Pro: upload an image, get the tuned model's description.

Runs on the GPU pod. Uses the SAME prompt format the model was trained on
(system: expert in <domain>; user: image + "Describe what is shown in this image.")
and enable_thinking=false from config_pro.yaml.

    pip install -q gradio
    cd /workspace/Nexgen_Lab/training && export HF_HOME=/workspace/hf
    export GRADIO_USER=<pick a user> GRADIO_PASS=<pick a password>
    python demo_gradio.py --adapter checkpoints/nexgen-pro-v1 --share

--share prints a temporary public https://....gradio.live link (about 72 h),
protected by GRADIO_USER / GRADIO_PASS. Without --share it listens on :7860 only.
Stop it with Ctrl+C, or kill the process; the model is not exposed, only this UI.
"""
import argparse, os, threading

import torch
import yaml
import gradio as gr
from peft import PeftModel
from PIL import Image
from transformers import AutoProcessor, TextIteratorStreamer

from eval_generate import load_model

DEFAULT_PROMPT = "Describe what is shown in this image."


def shrink(img: Image.Image, max_pixels: int) -> Image.Image:
    img = img.convert("RGB")
    if max_pixels and img.width * img.height > max_pixels:
        s = (max_pixels / (img.width * img.height)) ** 0.5
        img = img.resize((max(1, int(img.width * s)), max(1, int(img.height * s))), Image.LANCZOS)
    return img


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--adapter", default="checkpoints/nexgen-pro-v1")
    ap.add_argument("--base-model", default="Qwen/Qwen3.8-27B")
    ap.add_argument("--config", default="config_pro.yaml")
    ap.add_argument("--max-image-pixels", type=int, default=1400000)
    ap.add_argument("--port", type=int, default=7860)
    ap.add_argument("--share", action="store_true")
    a = ap.parse_args()

    cfg = yaml.safe_load(open(a.config)) if os.path.exists(a.config) else {}
    tk = cfg.get("chat_template_kwargs") or {}
    print("chat_template_kwargs:", tk)

    processor = AutoProcessor.from_pretrained(a.base_model)
    model = PeftModel.from_pretrained(load_model(a.base_model), a.adapter)
    model.eval()
    print("Model ready.")

    def describe(image, domain, prompt, max_new_tokens):
        if image is None:
            yield "Upload an image first."
            return
        domain = (domain or "general").strip()
        messages = [
            {"role": "system", "content": f"You are an expert assistant specializing in the {domain} domain."},
            {"role": "user", "content": [
                {"type": "image", "image": "uploaded"},
                {"type": "text", "text": (prompt or DEFAULT_PROMPT).strip()},
            ]},
        ]
        text = processor.apply_chat_template(messages, tokenize=False, add_generation_prompt=True, **tk)
        inputs = processor(text=[text], images=[shrink(image, a.max_image_pixels)],
                           return_tensors="pt").to(model.device)
        streamer = TextIteratorStreamer(processor.tokenizer, skip_prompt=True, skip_special_tokens=True)
        t = threading.Thread(target=model.generate, kwargs=dict(
            **inputs, streamer=streamer, max_new_tokens=int(max_new_tokens), do_sample=False))
        t.start()
        out = ""
        for piece in streamer:
            out += piece
            yield out
        t.join()

    ui = gr.Interface(
        fn=describe,
        inputs=[
            gr.Image(type="pil", label="Image"),
            gr.Textbox(value="engineering", label="Domain (e.g. radiology, clinical_cardiology, legal)"),
            gr.Textbox(value=DEFAULT_PROMPT, label="Prompt"),
            gr.Slider(64, 1024, value=500, step=32, label="Max new tokens"),
        ],
        outputs=gr.Textbox(label="NexGen Pro", lines=24),
        title="NexGen Pro v1 (test)",
        flagging_mode="never",
    )
    user, pw = os.environ.get("GRADIO_USER"), os.environ.get("GRADIO_PASS")
    auth = (user, pw) if user and pw else None
    if a.share and not auth:
        raise SystemExit("Refusing --share without GRADIO_USER and GRADIO_PASS set.")
    ui.queue().launch(server_name="0.0.0.0", server_port=a.port, share=a.share, auth=auth)


if __name__ == "__main__":
    main()
