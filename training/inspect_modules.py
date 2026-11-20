#!/usr/bin/env python3
"""List LoRA-able Linear modules of a base model WITHOUT downloading weights.

Builds the model on the meta device from its config only, then prints how
often each Linear-name suffix occurs and under which top-level branch.
Use the output to set lora_target_modules / lora_target_regex in the config.

    python inspect_modules.py Qwen/Qwen3.8-27B
"""
import sys
from collections import Counter

import torch
import transformers
from transformers import AutoConfig
from accelerate import init_empty_weights


def main(repo):
    cfg = AutoConfig.from_pretrained(repo)
    print("model_type:", cfg.model_type)
    model = None
    for name in ("AutoModelForCausalLM", "AutoModelForMultimodalLM",
                 "AutoModelForImageTextToText"):
        cls = getattr(transformers, name, None)
        if cls is None:
            continue
        try:
            with init_empty_weights():
                model = cls.from_config(cfg)
            print("built with", name)
            break
        except Exception as e:
            print(name, "failed:", str(e)[:150])
    if model is None:
        sys.exit("could not build model from config")
    suffix, branch = Counter(), Counter()
    for n, m in model.named_modules():
        if isinstance(m, torch.nn.Linear):
            suffix[n.split(".")[-1]] += 1
            branch[".".join(n.split(".")[:2])] += 1
    print("\nLinear suffix -> count")
    for k, v in suffix.most_common():
        print(f"  {k:24s} {v}")
    print("\nLinear count by top-level branch")
    for k, v in branch.most_common(12):
        print(f"  {k:40s} {v}")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "Qwen/Qwen3.8-27B")
