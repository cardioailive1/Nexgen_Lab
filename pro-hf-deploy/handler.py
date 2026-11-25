"""NexGen Pro v1 -- Hugging Face Inference Endpoints custom handler (image + text -> text).

Ship this file and requirements.txt at the ROOT of the adapter repo
(nexgen2/nexgen-pro-v1-lora). HF mounts that repo at `model_dir`, so the LoRA
adapter is read from there and the base model (Qwen/Qwen3.8-27B) is pulled
from the Hub.

Request (same shape the Lab already sends, plus optional images):
  {
    "system": "You are an expert assistant specializing in the radiology domain.",
    "messages": [{"role": "user", "content": [
        {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64,...."}},
        {"type": "text", "text": "Describe what is shown in this image."}]}],
    "max_tokens": 500
  }
Plain-string message content (text-only) also works. Images must be base64 data
URLs (or {"type":"image","image":"<base64>"}); remote URLs are rejected on purpose.

Response: {"content":[{"type":"text","text":"..."}], "usage":{...}, "model":"nexgen-pro-v1"}

Environment (optional): BASE_MODEL, LOAD_4BIT=1 (nf4, matches how it was trained
and evaluated; ~20 GB VRAM, slower), MERGE=0 to keep the adapter unmerged,
MAX_IMAGE_PIXELS, MAX_NEW_TOKENS_CAP.
"""
import base64
import io
import os
import re
import threading
from typing import Any, Dict, List

import torch
from PIL import Image
from transformers import AutoProcessor

BASE_MODEL = os.environ.get("BASE_MODEL", "Qwen/Qwen3.8-27B")
LOAD_4BIT = os.environ.get("LOAD_4BIT", "0") == "1"
MERGE = os.environ.get("MERGE", "1") == "1" and not LOAD_4BIT
MAX_IMAGE_PIXELS = int(os.environ.get("MAX_IMAGE_PIXELS", "1400000"))   # same cap as training
MAX_NEW_TOKENS_CAP = int(os.environ.get("MAX_NEW_TOKENS_CAP", "1024"))
MAX_IMAGES = 4
MAX_IMAGE_BYTES = 15 * 1024 * 1024
TEMPLATE_KWARGS = {"enable_thinking": False}   # must match chat_template_kwargs in config_pro.yaml
_DATA_URL = re.compile(r"^data:image/[a-zA-Z0-9.+-]+;base64,(.+)$", re.DOTALL)


def _load_model():
    import transformers
    from peft import PeftModel
    kwargs = dict(device_map="auto", torch_dtype=torch.bfloat16)
    if LOAD_4BIT:
        from transformers import BitsAndBytesConfig
        kwargs["quantization_config"] = BitsAndBytesConfig(
            load_in_4bit=True, bnb_4bit_quant_type="nf4",
            bnb_4bit_compute_dtype=torch.bfloat16, bnb_4bit_use_double_quant=True)
    last = None
    for name in ("AutoModelForImageTextToText", "AutoModelForMultimodalLM", "AutoModelForCausalLM"):
        cls = getattr(transformers, name, None)
        if cls is None:
            continue
        try:
            return cls, cls.from_pretrained(BASE_MODEL, **kwargs)
        except Exception as e:  # try the next auto class
            last = e
    raise RuntimeError(f"No loader worked for {BASE_MODEL}") from last


def _decode_image(spec: str) -> Image.Image:
    m = _DATA_URL.match(spec)
    b64 = m.group(1) if m else spec
    if spec.startswith(("http://", "https://", "file:", "/")):
        raise ValueError("Remote or local image paths are not accepted; send base64.")
    raw = base64.b64decode(b64, validate=False)
    if len(raw) > MAX_IMAGE_BYTES:
        raise ValueError("Image too large (limit 15 MB).")
    img = Image.open(io.BytesIO(raw)).convert("RGB")
    if img.width * img.height > MAX_IMAGE_PIXELS:
        s = (MAX_IMAGE_PIXELS / (img.width * img.height)) ** 0.5
        img = img.resize((max(1, int(img.width * s)), max(1, int(img.height * s))), Image.LANCZOS)
    return img


def _normalise(messages: List[dict], images: List[Image.Image]) -> List[dict]:
    out = []
    for m in messages:
        content = m.get("content", "")
        if isinstance(content, str):
            out.append({"role": m["role"], "content": content})
            continue
        parts = []
        for b in content:
            t = b.get("type")
            if t == "text":
                parts.append({"type": "text", "text": b.get("text", "")})
            elif t in ("image_url", "image"):
                spec = b["image_url"]["url"] if t == "image_url" else b["image"]
                if len(images) >= MAX_IMAGES:
                    raise ValueError(f"At most {MAX_IMAGES} images per request.")
                images.append(_decode_image(spec))
                parts.append({"type": "image", "image": "uploaded"})
        out.append({"role": m["role"], "content": parts})
    return out


class EndpointHandler:
    def __init__(self, model_dir: str = "", **kwargs) -> None:
        from peft import PeftModel
        self.processor = AutoProcessor.from_pretrained(BASE_MODEL)
        _, model = _load_model()
        model = PeftModel.from_pretrained(model, model_dir or ".")
        if MERGE:
            model = model.merge_and_unload()
        model.eval()
        self.model = model
        self.lock = threading.Lock()   # one generation at a time on the GPU

    def __call__(self, data: Dict[str, Any]) -> Any:
        data = data.get("inputs", data) if isinstance(data.get("inputs"), dict) else data
        system = data.get("system", "")
        max_new = min(int(data.get("max_tokens", 500)), MAX_NEW_TOKENS_CAP)
        images: List[Image.Image] = []
        try:
            msgs = _normalise(data.get("messages", []), images)
        except Exception as e:
            return {"error": str(e)}
        if system:
            msgs = [{"role": "system", "content": system}] + msgs

        text = self.processor.apply_chat_template(
            msgs, tokenize=False, add_generation_prompt=True, **TEMPLATE_KWARGS)
        if images:
            inputs = self.processor(text=[text], images=images, return_tensors="pt")
        else:
            inputs = self.processor(text=[text], return_tensors="pt")
        inputs = inputs.to(self.model.device)

        with self.lock, torch.no_grad():
            out = self.model.generate(**inputs, max_new_tokens=max_new, do_sample=False)
        n_in = inputs["input_ids"].shape[1]
        reply = self.processor.tokenizer.decode(out[0][n_in:], skip_special_tokens=True).strip()
        return {
            "content": [{"type": "text", "text": reply}],
            "usage": {"input_tokens": n_in, "output_tokens": int(out.shape[1] - n_in)},
            "model": "nexgen-pro-v1",
        }
