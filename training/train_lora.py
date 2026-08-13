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
from typing import List, Optional

import torch
import yaml
from datasets import load_dataset
from peft import LoraConfig, get_peft_model, prepare_model_for_kbit_training
from transformers import (
    AutoModelForCausalLM,
    AutoTokenizer,
    BitsAndBytesConfig,
    DataCollatorForLanguageModeling,
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


def format_example(example: dict, tokenizer) -> dict:
    """
    Expected JSONL record shape (see data_spec.md):
    {
      "system": "You are NexGen, an assistant specialised in <domain>...",
      "messages": [
        {"role": "user", "content": "..."},
        {"role": "assistant", "content": "..."}
      ]
    }
    Uses the base model's own chat template so formatting matches what it
    was instruction-tuned to expect.
    """
    messages = []
    if example.get("system"):
        messages.append({"role": "system", "content": example["system"]})
    messages.extend(example["messages"])
    text = tokenizer.apply_chat_template(
        messages, tokenize=False, add_generation_prompt=False
    )
    return {"text": text}


def build_model(cfg: NexGenTrainConfig):
    quant_config = None
    if cfg.use_4bit:
        quant_config = BitsAndBytesConfig(
            load_in_4bit=True,
            bnb_4bit_quant_type="nf4",
            bnb_4bit_compute_dtype=torch.bfloat16,
            bnb_4bit_use_double_quant=True,
        )

    model = AutoModelForCausalLM.from_pretrained(
        cfg.base_model,
        quantization_config=quant_config,
        device_map="auto",
        torch_dtype=torch.bfloat16,
    )

    if cfg.use_4bit:
        model = prepare_model_for_kbit_training(model)

    lora_config = LoraConfig(
        r=cfg.lora_r,
        lora_alpha=cfg.lora_alpha,
        lora_dropout=cfg.lora_dropout,
        target_modules=cfg.lora_target_modules,
        bias="none",
        task_type="CAUSAL_LM",
    )
    model = get_peft_model(model, lora_config)
    model.print_trainable_parameters()
    return model


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", type=str, default=None)
    args = parser.parse_args()
    cfg = load_config(args.config)

    torch.manual_seed(cfg.seed)

    tokenizer = AutoTokenizer.from_pretrained(cfg.base_model)
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token

    model = build_model(cfg)

    raw_train = load_dataset("json", data_files=cfg.train_file)["train"]
    raw_eval = (
        load_dataset("json", data_files=cfg.eval_file)["train"]
        if os.path.exists(cfg.eval_file)
        else None
    )

    def tokenize_fn(example):
        formatted = format_example(example, tokenizer)
        tokenized = tokenizer(
            formatted["text"],
            truncation=True,
            max_length=cfg.max_seq_len,
            padding=False,
        )
        tokenized["labels"] = tokenized["input_ids"].copy()
        return tokenized

    train_ds = raw_train.map(tokenize_fn, remove_columns=raw_train.column_names)
    eval_ds = (
        raw_eval.map(tokenize_fn, remove_columns=raw_eval.column_names)
        if raw_eval is not None
        else None
    )

    collator = DataCollatorForLanguageModeling(tokenizer=tokenizer, mlm=False)

    training_args = TrainingArguments(
        output_dir=cfg.output_dir,
        per_device_train_batch_size=cfg.per_device_train_batch_size,
        gradient_accumulation_steps=cfg.gradient_accumulation_steps,
        num_train_epochs=cfg.num_train_epochs,
        learning_rate=cfg.learning_rate,
        warmup_ratio=cfg.warmup_ratio,
        logging_steps=cfg.logging_steps,
        eval_strategy="steps" if eval_ds is not None else "no",
        eval_steps=cfg.eval_steps if eval_ds is not None else None,
        save_steps=cfg.save_steps,
        save_total_limit=cfg.save_total_limit,
        bf16=True,
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

    trainer.train()
    model.save_pretrained(cfg.output_dir)
    tokenizer.save_pretrained(cfg.output_dir)
    print(f"Done. LoRA adapter + tokenizer saved to {cfg.output_dir}")


if __name__ == "__main__":
    main()
