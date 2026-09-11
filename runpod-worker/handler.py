import torch
import runpod
from transformers import AutoModelForCausalLM, AutoTokenizer

BASE_MODEL = "Qwen/Qwen3.5-9B"
CHECKPOINT_URLS = {
    "checkpoint-400": "nexgen2/nexgen-flash-v1-merged",
    "checkpoint-averaged": "nexgen2/nexgen-flash-v1-merged-averaged",
}

print("Loading models — this happens once per worker, not per request...")
_models = {}
_tokenizers = {}
for name, repo in CHECKPOINT_URLS.items():
    print(f"Loading {name} from {repo}...")
    _tokenizers[name] = AutoTokenizer.from_pretrained(repo)
    _models[name] = AutoModelForCausalLM.from_pretrained(
        repo, torch_dtype=torch.bfloat16, device_map="auto"
    )
print("All models loaded. Ready to serve.")

def handler(event):
    data = event.get("input", {})
    model_name = data.get("model", "checkpoint-400")
    if model_name not in _models:
        return {"error": f"Unknown model '{model_name}'. Choose from: {list(_models.keys())}"}

    model = _models[model_name]
    tok = _tokenizers[model_name]
    messages = data.get("messages", [])
    system = data.get("system", "")
    max_tokens = data.get("max_tokens", 500)

    msgs = ([{"role": "system", "content": system}] if system else []) + messages
    text = tok.apply_chat_template(msgs, tokenize=False, add_generation_prompt=True)
    inputs = tok(text, return_tensors="pt").to(model.device)

    with torch.no_grad():
        out = model.generate(**inputs, max_new_tokens=max_tokens, do_sample=False)

    input_len = inputs["input_ids"].shape[1]
    response_text = tok.decode(out[0][input_len:], skip_special_tokens=True)
    return {
        "content": [{"type": "text", "text": response_text}],
        "usage": {"input_tokens": input_len, "output_tokens": out.shape[1] - input_len},
        "model": model_name,
    }

runpod.serverless.start({"handler": handler})