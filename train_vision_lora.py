#!/usr/bin/env python3
"""
NexGen — Vision LoRA / QLoRA Fine-Tuning Script
==================================================
Fine-tunes an open-weight vision-language base model (NexGen Pro/Ultra) on
the image+caption dataset exported from the Lab's Vision Data module.

This is the vision counterpart to train_lora.py — same conventions
(dataclass config, config.yaml overrides, DagsHub/MLflow tracking), but
uses AutoModelForImageTextToText + AutoProcessor instead of
AutoModelForCausalLM + AutoTokenizer, since a vision-language model needs
both text tokenization and image preprocessing together.

IMPORTANT — read before running:
Same as train_lora.py: a parameter-efficient FINE-TUNE of an existing
open-weight base model, not a from-scratch pretrain. LoRA is applied to
the LANGUAGE MODEL only — the vision encoder and projector stay frozen,
matching standard practice for this kind of fine-tune (the vision tower
already knows how to see; what's being taught is how to describe/reason
about domain-specific images in the target style).

Expects the exact dataset shape the Lab's vision export produces:
  dataset.zip
  ├── train.jsonl
  └── images/
      ├── <record_id>.jpg
      └── ...
Each JSONL line:
  {"system": "...", "messages": [
    {"role": "user", "content": [
      {"type": "image", "image": "images/<record_id>.jpg"},
      {"type": "text", "text": "Describe what is shown in this image."}
    ]},
    {"role": "assistant", "content": "<caption>"}
  ]}
This is the exact message format transformers' AutoProcessor expects
natively — no reshaping needed between what the Lab exports and what
training consumes.

Usage:
    python train_vision_lora.py --config config_pro.yaml --data train.jsonl

Requires: torch, transformers>=4.57, peft, bitsandbytes, datasets,
accelerate, pillow, qwen-vl-utils (if using a Qwen-VL-family base model)
"""

import argparse
import os
from dataclasses import dataclass, field
from typing import List, Optional

import torch
import yaml
from PIL import Image

# ── DagsHub + MLflow experiment tracking — identical pattern to
# train_lora.py, so vision and text runs show up side by side. ─────────────
try:
    import dagshub
    import mlflow
    dagshub.init(repo_owner='ksampson', repo_name='Nexgen_Lab', mlflow=True)
    MLFLOW_ENABLED = True
    print("DagsHub MLflow tracking enabled")
except ImportError:
    MLFLOW_ENABLED = False
    print("dagshub not installed — run: pip install dagshub mlflow")
except Exception as e:
    MLFLOW_ENABLED = False
    print(f"DagsHub/MLflow tracking unavailable ({e.__class__.__name__}: {e}) — continuing without it")

from datasets import load_dataset
from peft import LoraConfig, get_peft_model, prepare_model_for_kbit_training
from transformers import (
    AutoModelForImageTextToText,
    AutoProcessor,
    BitsAndBytesConfig,
    Trainer,
    TrainingArguments,
)


@dataclass
class NexGenVisionTrainConfig:
    # Point this at an open-weight vision-language base model you're
    # licensed to use — the NexGen Pro/Ultra base model, e.g. Qwen3.8-27B.
    base_model: str = "Qwen/Qwen3.8-27B"

    train_file: str = "train.jsonl"
    eval_file: str = "eval.jsonl"
    # Root the JSONL's relative "images/..." paths against — after the
    # bootstrap command unzips dataset.zip in place, this is just ".".
    images_root: str = "."
    output_dir: str = "checkpoints/nexgen-vision-v1"

    max_seq_len: int = 4096
    use_4bit: bool = True   # QLoRA — necessary at 27B+ scale on a single GPU, same reasoning as SEM's GRPO training config

    lora_r: int = 32
    lora_alpha: int = 64
    lora_dropout: float = 0.05
    # Language-model projections only — the vision encoder and
    # vision-to-language projector are deliberately NOT targeted here, so
    # they stay frozen. Matches standard practice for this kind of
    # fine-tune (teaching domain-specific description/reasoning, not
    # teaching the model to see from scratch).
    lora_target_modules: List[str] = field(
        default_factory=lambda: ["q_proj", "k_proj", "v_proj", "o_proj"]
    )

    learning_rate: float = 2e-4
    num_train_epochs: int = 3
    per_device_train_batch_size: int = 1   # vision inputs are far larger per-example than text-only — smaller batch than train_lora.py's default is realistic
    gradient_accumulation_steps: int = 16
    warmup_ratio: float = 0.03
    logging_steps: int = 10
    eval_steps: int = 200
    save_steps: int = 200
    save_total_limit: int = 3
    seed: int = 42
    report_to: str = "none"


def load_config(path: Optional[str]) -> NexGenVisionTrainConfig:
    cfg = NexGenVisionTrainConfig()
    if path and os.path.exists(path):
        with open(path) as f:
            overrides = yaml.safe_load(f) or {}
        for key, value in overrides.items():
            if hasattr(cfg, key):
                setattr(cfg, key, value)
            else:
                raise ValueError(f"Unknown config key: {key}")
    return cfg


def load_example_images(example: dict, images_root: str) -> List[Image.Image]:
    """Walks the example's messages, opens every referenced image file as a
    real PIL Image. Raises a clear error naming the missing file rather
    than a generic downstream crash if the ZIP wasn't unzipped correctly
    or a path doesn't match."""
    images = []
    for msg in example["messages"]:
        content = msg["content"]
        if not isinstance(content, list):
            continue
        for block in content:
            if block.get("type") == "image":
                image_path = os.path.join(images_root, block["image"])
                if not os.path.exists(image_path):
                    raise FileNotFoundError(
                        f"Referenced image not found: {image_path}. "
                        f"Confirm dataset.zip was extracted with images/ alongside train.jsonl, "
                        f"and --images-root points at that location."
                    )
                images.append(Image.open(image_path).convert("RGB"))
    return images


def build_model(cfg: NexGenVisionTrainConfig):
    quant_config = None
    if cfg.use_4bit:
        quant_config = BitsAndBytesConfig(
            load_in_4bit=True,
            bnb_4bit_quant_type="nf4",
            bnb_4bit_compute_dtype=torch.bfloat16,
            bnb_4bit_use_double_quant=True,
        )

    # AutoModelForImageTextToText dispatches to the correct underlying
    # vision-language model class based on the checkpoint's own config —
    # no need to import or guess a model-specific class here.
    model = AutoModelForImageTextToText.from_pretrained(
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


class VisionDataCollator:
    """Replaces train_lora.py's DataCollatorForLanguageModeling — that
    collator is text-only and has no concept of pixel_values. This builds
    each batch by re-running the processor's chat-template + image
    pipeline together, so text tokens and image patches stay correctly
    aligned, then pads to the batch's longest sequence."""

    def __init__(self, processor, images_root: str):
        self.processor = processor
        self.images_root = images_root

    def __call__(self, examples: List[dict]):
        texts, images_per_example = [], []
        for example in examples:
            messages = []
            if example.get("system"):
                messages.append({"role": "system", "content": example["system"]})
            messages.extend(example["messages"])
            texts.append(self.processor.apply_chat_template(messages, tokenize=False, add_generation_prompt=False))
            images_per_example.append(load_example_images(example, self.images_root))

        batch = self.processor(
            text=texts, images=images_per_example,
            return_tensors="pt", padding=True, truncation=True,
        )
        # Standard causal-LM labeling: predict every token, mask padding.
        # Image placeholder tokens are left unmasked deliberately — the
        # processor already replaces them with the model's real image
        # token id, and masking them would be incorrect (they're not pad
        # tokens, they're real input the loss should not be computed
        # against but the attention mask already handles correctly).
        labels = batch["input_ids"].clone()
        labels[labels == self.processor.tokenizer.pad_token_id] = -100
        batch["labels"] = labels
        return batch


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", type=str, default=None)
    parser.add_argument("--data", type=str, default=None, help="Overrides config's train_file, matches train_lora.py's --data flag for consistency")
    parser.add_argument("--images-root", type=str, default=None)
    args = parser.parse_args()
    cfg = load_config(args.config)
    if args.data:
        cfg.train_file = args.data
    if args.images_root:
        cfg.images_root = args.images_root

    torch.manual_seed(cfg.seed)

    processor = AutoProcessor.from_pretrained(cfg.base_model)
    if processor.tokenizer.pad_token is None:
        processor.tokenizer.pad_token = processor.tokenizer.eos_token

    model = build_model(cfg)

    train_ds = load_dataset("json", data_files=cfg.train_file)["train"]
    eval_ds = (
        load_dataset("json", data_files=cfg.eval_file)["train"]
        if os.path.exists(cfg.eval_file)
        else None
    )
    print(f"Loaded {len(train_ds)} training examples" + (f", {len(eval_ds)} eval examples" if eval_ds else ""))

    collator = VisionDataCollator(processor, cfg.images_root)

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
        # Vision batches contain PIL Images inside raw dataset dicts —
        # HF's default collation would try to tensor-ify them incorrectly.
        # remove_unused_columns=False keeps the raw examples intact so
        # VisionDataCollator gets exactly what it expects.
        remove_unused_columns=False,
    )

    trainer = Trainer(
        model=model,
        args=training_args,
        train_dataset=train_ds,
        eval_dataset=eval_ds,
        data_collator=collator,
    )

    if MLFLOW_ENABLED:
        import mlflow
        with mlflow.start_run(run_name=f"nexgen-vision-{cfg.output_dir.split('/')[-1]}"):
            mlflow.log_param('base_model', cfg.base_model)
            mlflow.log_param('num_train_epochs', cfg.num_train_epochs)
            mlflow.log_param('learning_rate', cfg.learning_rate)
            mlflow.log_param('per_device_train_batch_size', cfg.per_device_train_batch_size)
            mlflow.log_param('gradient_accumulation_steps', cfg.gradient_accumulation_steps)
            mlflow.log_param('use_4bit', cfg.use_4bit)
            mlflow.log_param('lora_r', cfg.lora_r)
            mlflow.log_param('lora_alpha', cfg.lora_alpha)
            mlflow.log_param('output_dir', cfg.output_dir)
            mlflow.log_param('train_samples', len(train_ds))
            mlflow.log_param('eval_samples', len(eval_ds) if eval_ds else 0)

            trainer.train(resume_from_checkpoint=os.environ.get("RESUME_FROM_CHECKPOINT") or None)

            if trainer.state.log_history:
                for entry in trainer.state.log_history:
                    step = entry.get('step', 0)
                    if 'loss' in entry:
                        mlflow.log_metric('train_loss', entry['loss'], step=step)
                    if 'eval_loss' in entry:
                        mlflow.log_metric('eval_loss', entry['eval_loss'], step=step)

                last = trainer.state.log_history[-1]
                mlflow.log_metric('final_train_loss', last.get('train_loss', last.get('loss', 0)))
                mlflow.log_metric('total_steps', trainer.state.global_step)

            mlflow.set_tag('model_tier', cfg.output_dir.split('/')[-1])
            mlflow.set_tag('base_model', cfg.base_model.split('/')[-1])
            mlflow.set_tag('framework', 'peft-lora-vision')

            model.save_pretrained(cfg.output_dir)
            processor.save_pretrained(cfg.output_dir)
            mlflow.log_artifacts(cfg.output_dir, artifact_path='checkpoint')
            print(f"Done. Checkpoint saved to {cfg.output_dir} and logged to DagsHub MLflow.")
    else:
        trainer.train(resume_from_checkpoint=os.environ.get("RESUME_FROM_CHECKPOINT") or None)
        model.save_pretrained(cfg.output_dir)
        processor.save_pretrained(cfg.output_dir)
        print(f"Done. LoRA adapter + processor saved to {cfg.output_dir}")


if __name__ == "__main__":
    main()
