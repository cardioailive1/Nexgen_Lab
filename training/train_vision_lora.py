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

Requires: torch, transformers>=5.8.0, peft, bitsandbytes, datasets,
accelerate, pillow, qwen-vl-utils (if using a Qwen-VL-family base model)
"""

import argparse
import os
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

import torch
import yaml
from PIL import Image

# ── DagsHub + MLflow experiment tracking — identical pattern to
# train_lora.py, so vision and text runs show up side by side. ─────────────
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
    MLFLOW_ENABLED = False
    print(f"DagsHub/MLflow tracking unavailable ({e.__class__.__name__}: {e}) — continuing without it")

from datasets import load_dataset
from peft import LoraConfig, get_peft_model, prepare_model_for_kbit_training
from transformers import (
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
    # Regex override (full-match). Pro config scopes it to the language model.
    lora_target_regex: Optional[str] = None
    # Same keys as train_lora.py so config_pro.yaml works for both scripts.
    assistant_only_loss: bool = True
    chat_template_kwargs: Dict[str, Any] = field(default_factory=dict)

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

    # Dispatch is by the checkpoint's own config; try the vision-language
    # auto classes in turn since the name differs across transformers versions.
    import transformers
    model, last = None, None
    for name in ("AutoModelForImageTextToText", "AutoModelForMultimodalLM",
                 "AutoModelForCausalLM"):
        cls = getattr(transformers, name, None)
        if cls is None:
            continue
        try:
            model = cls.from_pretrained(
                cfg.base_model, quantization_config=quant_config,
                device_map="auto", torch_dtype=torch.bfloat16)
            print(f"Loaded {cfg.base_model} with {name}")
            break
        except Exception as e:
            last = e
            print(f"{name} failed: {e.__class__.__name__}: {str(e)[:200]}")
    if model is None:
        raise RuntimeError(f"No loader worked for {cfg.base_model}") from last

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


def find_last(seq: list, sub: list) -> int:
    """Index just after the last occurrence of sub in seq, or -1."""
    n = len(sub)
    if n == 0:
        return -1
    for i in range(len(seq) - n, -1, -1):
        if seq[i:i + n] == sub:
            return i + n
    return -1


def mask_to_assistant(input_ids: list, header_ids: list, pad_id) -> list:
    """Labels: -100 everywhere except tokens after the last assistant header
    (the caption + end-of-turn). Padding is always -100. If the header is not
    found, returns None so the caller can fall back and warn."""
    start = find_last(input_ids, header_ids)
    if start < 0:
        return None
    return [
        tid if (i >= start and tid != pad_id) else -100
        for i, tid in enumerate(input_ids)
    ]


class VisionDataCollator:
    """Builds each batch through the processor so text tokens and image
    patches stay aligned. Loss is computed on the assistant caption only
    (system, user text and image placeholder tokens are masked) unless
    assistant_only_loss is false."""

    def __init__(self, processor, images_root: str, cfg=None):
        self.processor = processor
        self.images_root = images_root
        self.cfg = cfg
        self.kwargs = dict(getattr(cfg, "chat_template_kwargs", {}) or {})
        self.assistant_only = getattr(cfg, "assistant_only_loss", True)
        self.max_len = getattr(cfg, "max_seq_len", None)
        self.warned = False

    def _render(self, messages, gen=False):
        return self.processor.apply_chat_template(
            messages, tokenize=False, add_generation_prompt=gen, **self.kwargs)

    def _header_ids(self, messages):
        """Token ids of the assistant header the template adds before a reply."""
        base = self._render(messages[:-1], gen=False)
        with_gen = self._render(messages[:-1], gen=True)
        suffix = with_gen[len(base):] if with_gen.startswith(base) else ""
        if not suffix:
            return []
        return self.processor.tokenizer(suffix, add_special_tokens=False)["input_ids"]

    def __call__(self, examples: List[dict]):
        texts, images_per_example, headers = [], [], []
        for example in examples:
            messages = []
            if example.get("system"):
                messages.append({"role": "system", "content": example["system"]})
            messages.extend(example["messages"])
            texts.append(self._render(messages))
            headers.append(self._header_ids(messages))
            images_per_example.append(load_example_images(example, self.images_root))

        # No truncation: cutting a sequence can slice through image tokens and
        # break the image/placeholder count. Captions are short; warn if long.
        batch = self.processor(
            text=texts, images=images_per_example,
            return_tensors="pt", padding=True,
        )
        if self.max_len and batch["input_ids"].shape[1] > self.max_len and not self.warned:
            print(f"WARNING: batch length {batch['input_ids'].shape[1]} > max_seq_len {self.max_len}")
            self.warned = True
        pad_id = self.processor.tokenizer.pad_token_id
        rows = batch["input_ids"].tolist()
        labels = []
        for ids, header in zip(rows, headers):
            row = mask_to_assistant(ids, header, pad_id) if self.assistant_only else None
            if row is None:
                if self.assistant_only and not self.warned:
                    print("WARNING: assistant header not found; training on all tokens for this batch")
                    self.warned = True
                row = [-100 if t == pad_id else t for t in ids]
            labels.append(row)
        batch["labels"] = torch.tensor(labels)
        return batch


def preview(cfg, processor, n=3):
    """Run the real collator on a few examples and show what is trained on."""
    ds = load_dataset("json", data_files=cfg.train_file)["train"]
    collator = VisionDataCollator(processor, cfg.images_root, cfg)
    total = trained = 0
    for i in range(min(n, len(ds))):
        b = collator([ds[i]])
        ids, lab = b["input_ids"][0].tolist(), b["labels"][0].tolist()
        total += len(ids)
        trained += sum(1 for l in lab if l != -100)
        print(f"--- example {i} ({ds[i].get('domain')}) ---")
        print(processor.tokenizer.decode(ids)[:500])
        print(">>> TRAINED ON:")
        print(processor.tokenizer.decode([l for l in lab if l != -100])[:500])
    print(f"previewed {min(n, len(ds))} of {len(ds)} records; trained tokens {trained}/{total}")


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
    parser.add_argument("--data", type=str, default=None, help="Overrides config's train_file, matches train_lora.py's --data flag for consistency")
    parser.add_argument("--images-root", type=str, default=None)
    parser.add_argument("--eval-data", type=str, default=None)
    parser.add_argument("--output-dir", type=str, default=None)
    parser.add_argument("--max-steps", type=int, default=-1,
                        help="smoke test: stop after N optimizer steps")
    parser.add_argument("--preview", action="store_true",
                        help="show rendered examples + loss mask and exit (no model load)")
    args = parser.parse_args()
    cfg = load_config(args.config)
    if args.eval_data:
        cfg.eval_file = args.eval_data
    if args.output_dir:
        cfg.output_dir = args.output_dir
    if args.data:
        cfg.train_file = args.data
    if args.images_root:
        cfg.images_root = args.images_root

    torch.manual_seed(cfg.seed)

    processor = AutoProcessor.from_pretrained(cfg.base_model)
    if processor.tokenizer.pad_token is None:
        processor.tokenizer.pad_token = processor.tokenizer.eos_token

    if args.preview:
        preview(cfg, processor)
        return

    model = build_model(cfg)

    train_ds = load_dataset("json", data_files=cfg.train_file)["train"]
    eval_ds = (
        load_dataset("json", data_files=cfg.eval_file)["train"]
        if os.path.exists(cfg.eval_file)
        else None
    )
    print(f"Loaded {len(train_ds)} training examples" + (f", {len(eval_ds)} eval examples" if eval_ds else ""))

    collator = VisionDataCollator(processor, cfg.images_root, cfg)

    training_args = TrainingArguments(
        output_dir=cfg.output_dir,
        per_device_train_batch_size=cfg.per_device_train_batch_size,
        per_device_eval_batch_size=1,
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
