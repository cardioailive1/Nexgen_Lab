# NexGen — Training & Serving Pipeline

A complete, runnable path to a real, fine-tuned NexGen model: training
script, data specification, sample data, and a production inference
server. This replaces the live-API call that was previously wired into
the website's playground — once trained, the frontend talks to
`serve.py` on your own infrastructure instead of any third-party API.

## What this is, and isn't

**Is:** a parameter-efficient fine-tune (LoRA/QLoRA) of an open-weight
base model, steered with your own instruction data into the NexGen
persona and domain behaviour (clinical, mining safety, code, etc.). This
produces real, distinct model weights you control and deploy yourself.

**Isn't:** a from-scratch pretrain of a 1.8-trillion-parameter model.
That scale of project requires the kind of GPU fleet and budget that
only a handful of frontier labs have. If the product's public-facing
benchmark claims and parameter counts were written to match that
aspirational spec, they should be updated to reflect whatever you
actually train and measure — see `data_spec.md` section 6.

## Files

| File | Purpose |
|---|---|
| `train_lora.py` | LoRA/QLoRA fine-tuning script |
| `config_flash.yaml` / `config_pro.yaml` / `config_ultra.yaml` | Per-tier training configs — see the tier table in step 3 |
| `config.yaml` | Generic template the three tier configs are based on |
| `data_spec.md` | Format, sourcing, and quality requirements for training data |
| `build_dataset.py` | Generates the sample dataset below — read it as a worked example of the record format across domains, not a real data pipeline |
| `sample_data/train_example.jsonl` | 98 example records across 17 domains (format/style reference — still far short of production scale, see step 2) |
| `sample_data/eval_example.jsonl` | 5 held-out eval records on topics not present in train |
| `serve.py` | FastAPI inference server (loads base model + adapter, exposes chat + streaming endpoints) |
| `requirements.txt` | Python dependencies |

## Step-by-step

### 1. Pick a base model

Choose an open-weight model you're licensed to fine-tune and deploy
commercially (license terms vary — check before committing). Common
choices as of 2025-2026: Llama 3.x, Mistral/Mixtral, Qwen 2.5, Gemma.
Set `base_model` in `config.yaml` accordingly.

### 2. Build real training data

`sample_data/train_example.jsonl` has 98 records across 17 domains (chat,
code, reasoning, maths, statistics, physics, life sciences, engineering,
clinical, legal, art & culture, finance, environmental science, history,
mining safety, tool-use, safety/refusals) — enough to verify the pipeline
runs end-to-end and to see the format/style across every domain, still
nowhere near enough to actually train a production model on. Clinical,
legal, finance, mining-safety, and engineering records are tagged
`"review_status": "draft - needs domain expert review before production
use"` since they were drafted for format reference, not reviewed by an
actual clinician, attorney, financial advisor, mining safety engineer, or
licensed engineer — don't ship on them as-is. Follow `data_spec.md` to
build a dataset at real scale (realistically 10,000-50,000+ reviewed
examples for a multi-domain assistant; more for safety-critical domains),
and extend `build_dataset.py`'s pattern to add any further vertical you
need.

### 3. Pick a tier and provision GPUs

Three real configs are provided, each against a current (mid-2026),
Apache 2.0-licensed open-weight base — not the 1.8T-parameter figure
from the original marketing copy, which doesn't correspond to any
open-weight model that exists. Training a model at that scale from
scratch is the frontier-lab-scale undertaking covered earlier in this
README (hundreds of millions of dollars, tens of thousands of GPUs) —
nothing in this repo does that or pretends to.

| Tier | Config | Base model | Min. hardware | Notes |
|---|---|---|---|---|
| NexGen Flash | `config_flash.yaml` | Qwen3.5-9B (dense) | 1x 24GB GPU (RTX 4090, L40S) | Fast, cheap, single consumer-class GPU |
| NexGen Pro | `config_pro.yaml` | Qwen3.6-35B-A3B (MoE) | 1x H100 80GB | Production sweet spot; 27B dense is a same-tier alternative |
| NexGen Ultra | `config_ultra.yaml` | Qwen3.5-397B-A17B (MoE) | 4x H100 80GB (INT4) / 8x H100 80GB (FP8) | Largest real open-weight option available; single large node, not multi-node; read the caveats inside `config_ultra.yaml` before running |

MoE note (Pro and Ultra): the LoRA target module names in `train_lora.py`
default to a dense-model layout. Mixture-of-experts models route their
feed-forward layers through per-expert sub-modules with different
parameter names, which vary by implementation. Before training, load the
actual base model and run `for n, _ in model.named_modules(): print(n)`
to find the real module names, then update `lora_target_modules` in the
config accordingly — both MoE configs flag this with a placeholder.

Cloud rental (rough, varies by provider/region): a single H100 80GB runs
roughly $2-3/hr on-demand; an 8x H100 node for Ultra runs $20-30+/hr. A
Flash QLoRA fine-tune on a real ~20K-example dataset for 3 epochs is
typically a handful to a few tens of GPU-hours — tens to low hundreds of
dollars. Ultra-tier runs are a real budget line item, not a side
experiment — size the dataset and epoch count accordingly before
committing GPU-hours to it.

### 4. Train

```bash
pip install -r requirements.txt
python train_lora.py --config config_flash.yaml   # or config_pro.yaml / config_ultra.yaml
```

Watch the loss curve; if eval loss diverges from train loss you're
overfitting (reduce epochs, increase data, or add dropout).

### 5. Serve

```bash
export NEXGEN_BASE_MODEL="meta-llama/Meta-Llama-3.1-8B-Instruct"
export NEXGEN_ADAPTER_PATH="checkpoints/nexgen-v1"
export NEXGEN_ALLOWED_ORIGINS="https://your-production-domain.com"
uvicorn serve:app --host 0.0.0.0 --port 8000
```

`/v1/chat` returns a full completion; `/v1/chat/stream` is SSE for the
playground's live-typing effect. No API keys involved anywhere in this
path — the model runs on your hardware, the frontend calls your server.

### 6. Wire the frontend to it

In the website's playground JS, replace the local
`generateResponse(mode, text)` simulation call with a `fetch()` to your
`serve.py` endpoint (same shape as the old Anthropic call, minus the key
and minus the identity-masking system prompt — just your own system
prompt per mode, same as what's already in `sample_data`'s `system`
field per domain). Happy to write that frontend wiring once you've got a
trained checkpoint running and want to connect it.

### 7. Evaluate honestly

Before publishing any benchmark numbers, run your checkpoint against the
actual public eval harnesses (lm-evaluation-harness covers MMLU, GSM8K,
HumanEval, etc.) and report only measured results.
