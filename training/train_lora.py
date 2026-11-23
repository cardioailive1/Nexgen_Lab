#!/usr/bin/env python3
"""
NexGen — LoRA / QLoRA Fine-Tuning Script
==========================================
Fine-tunes an open-weight base model on a custom instruction dataset to
produce a distinct, deployable "NexGen" checkpoint.

IMPORTANT — read before running:
This is a parameter-efficient FINE-TUNE of an existing open-weight base
model, not a from-scratch pretrain. It is the realistic path to a real,
working, deployable model without frontier-lab-scale compute.

Realistic hardware:
  - QLoRA (4-bit) on a 7B-13B base model -> single 24GB GPU (e.g. RTX 4090,
    L4, A10G) is enough.
  - LoRA (bf16) on a 7B base -> single 40-80GB GPU (A100/H100).
  - 70B-class base models -> multi-GPU node (e.g. 4-8x A100/H100) or 4-bit
    QLoRA on a single 80GB GPU with longer training time.

This script does not download or bundle any base model weights. Point
--base-model / config.yaml at whatever open-weight model you have a
license to use and have already downloaded (or have network access to
pull from your own model registry/mirror).

Usage:
    python train_lora.py --config config.yaml

Requires: torch, transformers, peft, bitsandbytes, datasets, accelerate
"""

import argparse
import os
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

import torch
import yaml

# ── DagsHub + MLflow experiment tracking ──────────────────────────────────────
# Logs every training run to dagshub.com/ksampson/Nexgen_Lab
# View runs at: https://dagshub.com/ksampson/Nexgen_Lab.mlflow
try:
    if os.environ.get('NEXGEN_TRACKING') != '1':
        raise RuntimeError('tracking off; set NEXGEN_TRACKING=1 to enable')
    import dagshub
    import mlflow
    dagshub.init(repo_owner='ksampson', repo_name='Nexgen_Lab', mlflow=True)
    MLFLOW_ENABLED = True
    print("DagsHub MLflow tracking enabled")
except ImportError:
    MLFLOW_ENABLED = False
    print("dagshub not installed — run: pip install dagshub mlflow")
except Exception as e:
    # Anything else — auth failures, OAuth errors, network issues, wrong
    # repo owner/name — should never take down training itself. Tracking
    # is a nice-to-have; the training run is the actual point.
    MLFLOW_ENABLED = False
    print(f"DagsHub/MLflow tracking unavailable ({e.__class__.__name__}: {e}) — continuing without it")
from datasets import load_dataset
from peft import LoraConfig, get_peft_model, prepare_model_for_kbit_training
from transformers import (
    AutoModelForCausalLM,
    AutoTokenizer,
    BitsAndBytesConfig,
    Trainer,
    TrainingArguments,
)


@dataclass
class NexGenTrainConfig:
    # Point this at an open-weight base model you're licensed to use.
    base_model: str = "meta-llama/Meta-Llama-3.1-8B-Instruct"

    train_file: str = "sample_data/train_example.jsonl"
    eval_file: str = "sample_data/eval_example.jsonl"
    output_dir: str = "checkpoints/nexgen-v1"

    max_seq_len: int = 4096
    use_4bit: bool = True  # QLoRA — set False if you have enough VRAM for bf16 LoRA

    lora_r: int = 32
    lora_alpha: int = 64
    lora_dropout: float = 0.05
    lora_target_modules: List[str] = field(
        default_factory=lambda: [
            "q_proj", "k_proj", "v_proj", "o_proj",
            "gate_proj", "up_proj", "down_proj",
        ]
    )

    # Optional regex (full-match on module name) that overrides the list above.
    # Use it to restrict LoRA to the language model of a vision-language base
    # so the vision tower is left untouched. Find names with inspect_modules.py.
    lora_target_regex: Optional[str] = None

    # Loss only on assistant tokens (system/user tokens are masked to -100).
    assistant_only_loss: bool = True
    # Extra kwargs for tokenizer.apply_chat_template, e.g. {enable_thinking: false}
    chat_template_kwargs: Dict[str, Any] = field(default_factory=dict)

    learning_rate: float = 2e-4
    num_train_epochs: int = 3
    per_device_train_batch_size: int = 2
    gradient_accumulation_steps: int = 8
    warmup_ratio: float = 0.03
    logging_steps: int = 10
    eval_steps: int = 200
    save_steps: int = 200
    save_total_limit: int = 3
    seed: int = 42
    report_to: str = "none"  # set to "wandb" for experiment tracking


def load_config(path: Optional[str]) -> NexGenTrainConfig:
    cfg = NexGenTrainConfig()
    if path and os.path.exists(path):
        with open(path) as f:
            overrides = yaml.safe_load(f) or {}
        for key, value in overrides.items():
            if hasattr(cfg, key):
                setattr(cfg, key, value)
            else:
                raise ValueError(f"Unknown config key: {key}")
    return cfg


def to_messages(example: dict) -> list:
    messages = []
    if example.get("system"):
        messages.append({"role": "system", "content": example["system"]})
    messages.extend(example["messages"])
    return messages


def render(tokenizer, messages, cfg, generation_prompt=False) -> str:
    return tokenizer.apply_chat_template(
        messages,
        tokenize=False,
        add_generation_prompt=generation_prompt,
        **(cfg.chat_template_kwargs or {}),
    )


def assistant_spans(messages, tokenizer, cfg):
    """Return (full_text, [(char_start, char_end), ...]) for assistant replies.

    Each span covers the assistant turn exactly as the chat template renders it
    (generation prompt excluded, closing end-of-turn token included). If the
    template rewrites earlier turns (e.g. strips reasoning), the prefix check
    fails and we fall back to training on the final assistant turn only.
    """
    full = render(tokenizer, messages, cfg)
    spans = []
    ok = True
    for i, m in enumerate(messages):
        if m["role"] != "assistant":
            continue
        prefix = render(tokenizer, messages[:i], cfg, generation_prompt=True)
        upto = render(tokenizer, messages[: i + 1], cfg)
        if not (full.startswith(upto) and upto.startswith(prefix)):
            ok = False
            break
        spans.append((len(prefix), len(upto)))
    if not ok or not spans:
        last = max(i for i, m in enumerate(messages) if m["role"] == "assistant")
        prefix = render(tokenizer, messages[:last], cfg, generation_prompt=True)
        if not full.startswith(prefix):
            return full, [(0, len(full))]  # last resort: all tokens
        spans = [(len(prefix), len(full))]
    return full, spans


def encode_example(example: dict, tokenizer, cfg) -> dict:
    messages = to_messages(example)
    if not cfg.assistant_only_loss:
        text = render(tokenizer, messages, cfg)
        enc = tokenizer(text, truncation=True, max_length=cfg.max_seq_len,
                        add_special_tokens=False)
        enc["labels"] = list(enc["input_ids"])
        return enc
    text, spans = assistant_spans(messages, tokenizer, cfg)
    enc = tokenizer(text, truncation=True, max_length=cfg.max_seq_len,
                    add_special_tokens=False, return_offsets_mapping=True)
    labels = []
    for tid, (a, b) in zip(enc["input_ids"], enc["offset_mapping"]):
        inside = any(a >= s and a < e for s, e in spans)
        labels.append(tid if inside else -100)
    enc["labels"] = labels
    del enc["offset_mapping"]
    return enc


class PadCollator:
    """Pads input_ids/attention_mask with pad id and labels with -100."""

    def __init__(self, tokenizer):
        self.pad_id = tokenizer.pad_token_id

    def __call__(self, batch):
        n = max(len(b["input_ids"]) for b in batch)
        out = {"input_ids": [], "attention_mask": [], "labels": []}
        for b in batch:
            pad = n - len(b["input_ids"])
            out["input_ids"].append(b["input_ids"] + [self.pad_id] * pad)
            out["attention_mask"].append([1] * len(b["input_ids"]) + [0] * pad)
            out["labels"].append(b["labels"] + [-100] * pad)
        return {k: torch.tensor(v) for k, v in out.items()}


def load_base_model(cfg, quant_config):
    """Qwen3.8 is a native vision-language checkpoint: AutoModelForCausalLM may
    not map its config, so try the causal-LM class first and fall back."""
    import transformers
    kwargs = dict(quantization_config=quant_config, device_map="auto",
                  torch_dtype=torch.bfloat16)
    names = ["AutoModelForCausalLM", "AutoModelForMultimodalLM",
             "AutoModelForImageTextToText"]
    last = None
    for name in names:
        cls = getattr(transformers, name, None)
        if cls is None:
            continue
        try:
            model = cls.from_pretrained(cfg.base_model, **kwargs)
            print(f"Loaded {cfg.base_model} with {name}")
            return model
        except Exception as e:  # try the next loader
            last = e
            print(f"{name} failed: {e.__class__.__name__}: {str(e)[:200]}")
    raise RuntimeError(f"No loader worked for {cfg.base_model}") from last


def build_model(cfg: NexGenTrainConfig):
    quant_config = None
    if cfg.use_4bit:
        quant_config = BitsAndBytesConfig(
            load_in_4bit=True,
            bnb_4bit_quant_type="nf4",
            bnb_4bit_compute_dtype=torch.bfloat16,
            bnb_4bit_use_double_quant=True,
        )

    model = load_base_model(cfg, quant_config)

    if cfg.use_4bit:
        model = prepare_model_for_kbit_training(model)

    lora_config = LoraConfig(
        r=cfg.lora_r,
        lora_alpha=cfg.lora_alpha,
        lora_dropout=cfg.lora_dropout,
        target_modules=cfg.lora_target_regex or cfg.lora_target_modules,
        bias="none",
        task_type="CAUSAL_LM",
    )
    model = get_peft_model(model, lora_config)
    model.print_trainable_parameters()
    return model


def preview(cfg, tokenizer, n=3):
    """Show what the model will actually be trained on. Run this first."""
    from datasets import load_dataset as _ld
    ds = _ld("json", data_files=cfg.train_file)["train"]
    total = trained = 0
    for i, ex in enumerate(ds):
        enc = encode_example(ex, tokenizer, cfg)
        total += len(enc["labels"])
        trained += sum(1 for l in enc["labels"] if l != -100)
        if i < n:
            print(f"--- example {i} ({ex.get('domain')}) ---")
            print(tokenizer.decode(enc["input_ids"])[:600])
            print(">>> TRAINED ON:")
            print(tokenizer.decode([l for l in enc["labels"] if l != -100])[:600])
    print(f"records={len(ds)} tokens={total} trained_tokens={trained} "
          f"({100*trained/max(total,1):.0f}%)")


def compute_warmup_steps(n_examples, cfg, max_steps=-1):
    """transformers 5.x removed warmup_ratio; pass an explicit step count instead
    (works on every version)."""
    import math
    if max_steps and max_steps > 0:
        total = max_steps
    else:
        per_step = max(1, cfg.per_device_train_batch_size * cfg.gradient_accumulation_steps)
        total = math.ceil(n_examples / per_step) * cfg.num_train_epochs
    return max(1, int(total * cfg.warmup_ratio))

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", type=str, default=None)
    parser.add_argument("--data", type=str, default=None,
                        help="train JSONL (overrides train_file), e.g. the Frontier Lab export")
    parser.add_argument("--eval-data", type=str, default=None)
    parser.add_argument("--output-dir", type=str, default=None)
    parser.add_argument("--max-steps", type=int, default=-1,
                        help="smoke test: stop after N optimizer steps")
    parser.add_argument("--preview", action="store_true",
                        help="print rendered examples + loss mask and exit (no GPU/model needed)")
    args = parser.parse_args()
    cfg = load_config(args.config)
    if args.data:
        cfg.train_file = args.data
    if args.eval_data:
        cfg.eval_file = args.eval_data
    if args.output_dir:
        cfg.output_dir = args.output_dir

    torch.manual_seed(cfg.seed)

    tokenizer = AutoTokenizer.from_pretrained(cfg.base_model)
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token

    if args.preview:
        preview(cfg, tokenizer)
        return

    model = build_model(cfg)

    raw_train = load_dataset("json", data_files=cfg.train_file)["train"]
    raw_eval = (
        load_dataset("json", data_files=cfg.eval_file)["train"]
        if os.path.exists(cfg.eval_file)
        else None
    )

    def tokenize_fn(example):
        return encode_example(example, tokenizer, cfg)

    train_ds = raw_train.map(tokenize_fn, remove_columns=raw_train.column_names)
    eval_ds = (
        raw_eval.map(tokenize_fn, remove_columns=raw_eval.column_names)
        if raw_eval is not None
        else None
    )

    collator = PadCollator(tokenizer)

    training_args = TrainingArguments(
        output_dir=cfg.output_dir,
        per_device_train_batch_size=cfg.per_device_train_batch_size,
        gradient_accumulation_steps=cfg.gradient_accumulation_steps,
        num_train_epochs=cfg.num_train_epochs,
        learning_rate=cfg.learning_rate,
        warmup_steps=compute_warmup_steps(len(train_ds), cfg, args.max_steps),
        logging_steps=cfg.logging_steps,
        eval_strategy="steps" if eval_ds is not None else "no",
        eval_steps=cfg.eval_steps if eval_ds is not None else None,
        save_steps=cfg.save_steps,
        save_total_limit=cfg.save_total_limit,
        bf16=torch.cuda.is_available(),
        gradient_checkpointing=True,
        gradient_checkpointing_kwargs={"use_reentrant": False},
        max_steps=args.max_steps,
        remove_unused_columns=False,
        report_to=cfg.report_to,
        seed=cfg.seed,
    )

    trainer = Trainer(
        model=model,
        args=training_args,
        train_dataset=train_ds,
        eval_dataset=eval_ds,
        data_collator=collator,
    )

    # ── MLflow run (logs params + metrics to DagsHub) ─────────────────────────
    if MLFLOW_ENABLED:
        import mlflow
        with mlflow.start_run(run_name=f"nexgen-{cfg.output_dir.split('/')[-1]}"):

            # Log all training hyperparameters
            mlflow.log_param('base_model',                  cfg.base_model)
            mlflow.log_param('num_train_epochs',            cfg.num_train_epochs)
            mlflow.log_param('learning_rate',               cfg.learning_rate)
            mlflow.log_param('per_device_train_batch_size', cfg.per_device_train_batch_size)
            mlflow.log_param('gradient_accumulation_steps', cfg.gradient_accumulation_steps)
            mlflow.log_param('max_seq_len',                 cfg.max_seq_len)
            mlflow.log_param('use_4bit',                    cfg.use_4bit)
            mlflow.log_param('lora_r',                      cfg.lora_r)
            mlflow.log_param('lora_alpha',                  cfg.lora_alpha)
            mlflow.log_param('warmup_ratio',                cfg.warmup_ratio)
            mlflow.log_param('output_dir',                  cfg.output_dir)
            mlflow.log_param('train_samples',               len(train_ds))
            mlflow.log_param('eval_samples',                len(eval_ds) if eval_ds else 0)

            trainer.train()

            # Log final training metrics
            if trainer.state.log_history:
                for entry in trainer.state.log_history:
                    step = entry.get('step', 0)
                    if 'loss' in entry:
                        mlflow.log_metric('train_loss', entry['loss'], step=step)
                    if 'eval_loss' in entry:
                        mlflow.log_metric('eval_loss', entry['eval_loss'], step=step)
                    if 'learning_rate' in entry:
                        mlflow.log_metric('learning_rate', entry['learning_rate'], step=step)

                last = trainer.state.log_history[-1]
                mlflow.log_metric('final_train_loss', last.get('train_loss', last.get('loss', 0)))
                mlflow.log_metric('total_steps',      trainer.state.global_step)
                mlflow.log_metric('epochs_completed',  trainer.state.epoch or cfg.num_train_epochs)

            # Tag the run for easy filtering in DagsHub
            mlflow.set_tag('model_tier',  cfg.output_dir.split('/')[-1])
            mlflow.set_tag('base_model',  cfg.base_model.split('/')[-1])
            mlflow.set_tag('framework',   'peft-lora')

            model.save_pretrained(cfg.output_dir)
            tokenizer.save_pretrained(cfg.output_dir)
            mlflow.log_artifacts(cfg.output_dir, artifact_path='checkpoint')
            print(f"Done. Checkpoint saved to {cfg.output_dir} and logged to DagsHub MLflow.")
    else:
        trainer.train()
        model.save_pretrained(cfg.output_dir)
        tokenizer.save_pretrained(cfg.output_dir)
        print(f"Done. LoRA adapter + tokenizer saved to {cfg.output_dir}")


if __name__ == "__main__":
    main()
