from typing import Any, Dict
import torch
from transformers import AutoModelForCausalLM, AutoTokenizer

MODEL_ID = "Qwen/Qwen3.8-27B"

class EndpointHandler:
    def __init__(self, model_dir: str, **kwargs) -> None:
        # model_dir is the path HF mounts the repo at — works whether this
        # handler ships alongside a full model repo, or alongside just this
        # file with MODEL_ID above pointing at the real weights on the Hub.
        source = model_dir if model_dir else MODEL_ID
        self.tokenizer = AutoTokenizer.from_pretrained(source)
        self.model = AutoModelForCausalLM.from_pretrained(
            source, torch_dtype=torch.bfloat16, device_map="auto"
        )

    def __call__(self, data: Dict[str, Any]) -> Any:
        messages = data.get("messages", [])
        system = data.get("system", "")
        max_tokens = data.get("max_tokens", 500)

        msgs = ([{"role": "system", "content": system}] if system else []) + messages
        text = self.tokenizer.apply_chat_template(msgs, tokenize=False, add_generation_prompt=True)
        inputs = self.tokenizer(text, return_tensors="pt").to(self.model.device)

        with torch.no_grad():
            out = self.model.generate(**inputs, max_new_tokens=max_tokens, do_sample=False)

        input_len = inputs["input_ids"].shape[1]
        response_text = self.tokenizer.decode(out[0][input_len:], skip_special_tokens=True)
        return {
            "content": [{"type": "text", "text": response_text}],
            "usage": {"input_tokens": input_len, "output_tokens": out.shape[1] - input_len},
        }
