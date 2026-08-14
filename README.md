# NexGen — Monorepo

**Corverxis Technologies · AI Engineering & Consulting**

This repository contains all components of the NexGen LLM product:

```
nexgen/
├── .github/
│   └── workflows/
│       ├── deploy-lab.yml        — Auto-deploys frontier lab to Render on push to lab/
│       ├── deploy-product.yml    — Auto-deploys product to Render on push to product/
│       ├── validate-data.yml     — Validates JSONL dataset on every PR or push
│       └── training.yml          — Manual training pipeline (any tier, logs to lab)
│
├── lab/                          — NexGen Frontier Lab (internal engineering platform)
│   ├── server.js                 — Express backend: all pipeline APIs
│   ├── package.json
│   ├── prisma/
│   │   └── schema.prisma         — PostgreSQL schema (Records, Jobs, Pipelines, RAG, etc.)
│   └── static/
│       └── index.html            — Full Corverxis-branded frontend (12 modules)
│
├── product/                      — Public NexGen AI assistant
│   └── index.html                — The deployed product site (calls lab API when live)
│
├── training/                     — LoRA/PEFT training pipeline
│   ├── train_lora.py             — QLoRA fine-tuning script
│   ├── config_flash.yaml         — Flash tier config (Qwen3.5-9B)
│   ├── config_pro.yaml           — Pro tier config (Qwen3.6-35B MoE)
│   ├── config_ultra.yaml         — Ultra tier config (Qwen3.5-397B MoE)
│   ├── serve.py                  — FastAPI inference server
│   ├── build_dataset.py          — Dataset builder (17 domains)
│   ├── requirements.txt
│   └── sample_data/
│       ├── train_example.jsonl   — Training records (validated on every PR)
│       └── eval_example.jsonl    — Held-out eval records
│
├── render.yaml                   — Render Blueprint: deploys both services from this repo
└── README.md                     — This file
```

---

## How the pieces connect

```
GitHub repo (this)
    │
    ├─ push to lab/**  ──► GitHub Actions: deploy-lab.yml ──► Render deploy hook ──► nexgen-frontier-lab.onrender.com
    │
    ├─ push to product/** ► GitHub Actions: deploy-product.yml ──► Render deploy hook ──► nexgen-product.onrender.com
    │
    ├─ PR touching sample_data/** ► GitHub Actions: validate-data.yml ──► JSONL validation
    │
    └─ Manual trigger ──► GitHub Actions: training.yml ──► GPU runner ──► checkpoint artifact
                                                               │
                                                               └──► POST /api/experiments to lab (logs run)
```

---

## Initial setup

### 1. Clone and structure

```bash
git clone https://github.com/corverxis/nexgen.git
cd nexgen

# Copy lab files from the nexgen-v2-fullstack.zip into lab/
cp -r /path/to/nexgen-v2/. lab/

# Copy the product frontend into product/
cp /path/to/nexarion-ai.html product/index.html

# Copy training pipeline into training/
cp -r /path/to/nexgen-training/. training/
```

### 2. Connect to Render

```bash
# Push to GitHub first
git add .
git commit -m "Initial NexGen monorepo"
git push origin main
```

Then: Render → New → Blueprint → connect this repo → Render reads `render.yaml` and creates both services and the PostgreSQL database automatically.

### 3. Set GitHub Secrets

Go to: **GitHub → Settings → Secrets and variables → Actions → New repository secret**

| Secret | Value | How to get it |
|---|---|---|
| `RENDER_LAB_DEPLOY_HOOK` | `https://api.render.com/deploy/srv-xxx` | Render → nexgen-frontier-lab → Settings → Deploy Hook |
| `RENDER_PRODUCT_DEPLOY_HOOK` | `https://api.render.com/deploy/srv-xxx` | Render → nexgen-product → Settings → Deploy Hook |
| `LAB_URL` | `https://nexgen-frontier-lab.onrender.com` | Your lab's Render URL |
| `HF_TOKEN` | `hf_...` | HuggingFace → Settings → Access Tokens (for gated models) |

### 4. Set Render Environment Variables

In Render → nexgen-frontier-lab → Environment:

| Variable | Required | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | Yes | Data generation + validation |
| `OPENAI_API_KEY` | Optional | pgvector embeddings in RAG |
| `LANGFUSE_SECRET_KEY` | Optional | Trace forwarding to Langfuse |
| `MLFLOW_TRACKING_URI` | Optional | Experiment forwarding to MLflow |
| `GCP_PROJECT` | Optional | Vertex AI deployment |
| `GITHUB_REPO` | Optional | `corverxis/nexgen` — enables GitHub MCP panel in lab |

---

## GitHub MCP Server (connect the lab to this repo)

In the Frontier Lab → **MCP Servers** module, register:

| Field | Value |
|---|---|
| Name | `github` |
| URL | `npx -y @modelcontextprotocol/server-github` |
| Type | `stdio` |

Then in Render → Environment, add:
```
GITHUB_PERSONAL_ACCESS_TOKEN=ghp_...   (GitHub → Settings → Developer settings → Personal access tokens)
```

This gives your lab's AI assistant direct read/write access to this repo — it can read training records, open PRs, trigger workflows, and push changes.

---

## Triggering a training run from the lab

In the lab → **Scripts** module, the `Generate Training Data` script calls your backend API to build records. Once you have enough approved records:

1. Go to **GitHub → Actions → Training Pipeline → Run workflow**
2. Select tier (flash / pro / ultra)
3. The workflow validates the data, runs training, uploads the checkpoint, and logs the experiment run back to the lab automatically via the `LAB_URL` secret.

---

## Product ↔ Lab API

Once a checkpoint is trained and `training/serve.py` is running on GPU infrastructure, update the product frontend:

```js
// In product/index.html — change this line:
var NEXGEN_API_BASE = window.NEXGEN_API_BASE || 'http://localhost:8000';
// to:
var NEXGEN_API_BASE = 'https://your-inference-server.onrender.com';
```

Push to `product/` → GitHub Actions auto-deploys the updated product to Render.

# NexGen — Monorepo

**Corverxis Technologies · AI Engineering & Consulting**

This repository contains all components of the NexGen LLM product:

```
nexgen/
├── .github/
│   └── workflows/
│       ├── deploy-lab.yml        — Auto-deploys frontier lab to Render on push to lab/
│       ├── deploy-product.yml    — Auto-deploys product to Render on push to product/
│       ├── validate-data.yml     — Validates JSONL dataset on every PR or push
│       └── training.yml          — Manual training pipeline (any tier, logs to lab)
│
├── lab/                          — NexGen Frontier Lab (internal engineering platform)
│   ├── server.js                 — Express backend: all pipeline APIs
│   ├── package.json
│   ├── prisma/
│   │   └── schema.prisma         — PostgreSQL schema (Records, Jobs, Pipelines, RAG, etc.)
│   └── static/
│       └── index.html            — Full Corverxis-branded frontend (12 modules)
│
├── product/                      — Public NexGen AI assistant
│   └── index.html                — The deployed product site (calls lab API when live)
│
├── training/                     — LoRA/PEFT training pipeline
│   ├── train_lora.py             — QLoRA fine-tuning script
│   ├── config_flash.yaml         — Flash tier config (Qwen3.5-9B)
│   ├── config_pro.yaml           — Pro tier config (Qwen3.6-35B MoE)
│   ├── config_ultra.yaml         — Ultra tier config (Qwen3.5-397B MoE)
│   ├── serve.py                  — FastAPI inference server
│   ├── build_dataset.py          — Dataset builder (17 domains)
│   ├── requirements.txt
│   └── sample_data/
│       ├── train_example.jsonl   — Training records (validated on every PR)
│       └── eval_example.jsonl    — Held-out eval records
│
├── render.yaml                   — Render Blueprint: deploys both services from this repo
└── README.md                     — This file
```

---

## How the pieces connect

```
GitHub repo (this)
    │
    ├─ push to lab/**  ──► GitHub Actions: deploy-lab.yml ──► Render deploy hook ──► nexgen-frontier-lab.onrender.com
    │
    ├─ push to product/** ► GitHub Actions: deploy-product.yml ──► Render deploy hook ──► nexgen-product.onrender.com
    │
    ├─ PR touching sample_data/** ► GitHub Actions: validate-data.yml ──► JSONL validation
    │
    └─ Manual trigger ──► GitHub Actions: training.yml ──► GPU runner ──► checkpoint artifact
                                                               │
                                                               └──► POST /api/experiments to lab (logs run)
```

---

## Initial setup

### 1. Clone and structure

```bash
git clone https://github.com/corverxis/nexgen.git
cd nexgen

# Copy lab files from the nexgen-v2-fullstack.zip into lab/
cp -r /path/to/nexgen-v2/. lab/

# Copy the product frontend into product/
cp /path/to/nexarion-ai.html product/index.html

# Copy training pipeline into training/
cp -r /path/to/nexgen-training/. training/
```

### 2. Connect to Render

```bash
# Push to GitHub first
git add .
git commit -m "Initial NexGen monorepo"
git push origin main
```

Then: Render → New → Blueprint → connect this repo → Render reads `render.yaml` and creates both services and the PostgreSQL database automatically.

### 3. Set GitHub Secrets

Go to: **GitHub → Settings → Secrets and variables → Actions → New repository secret**

| Secret | Value | How to get it |
|---|---|---|
| `RENDER_LAB_DEPLOY_HOOK` | `https://api.render.com/deploy/srv-xxx` | Render → nexgen-frontier-lab → Settings → Deploy Hook |
| `RENDER_PRODUCT_DEPLOY_HOOK` | `https://api.render.com/deploy/srv-xxx` | Render → nexgen-product → Settings → Deploy Hook |
| `LAB_URL` | `https://nexgen-frontier-lab.onrender.com` | Your lab's Render URL |
| `HF_TOKEN` | `hf_...` | HuggingFace → Settings → Access Tokens (for gated models) |

### 4. Set Render Environment Variables

In Render → nexgen-frontier-lab → Environment:

| Variable | Required | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | Yes | Data generation + validation |
| `OPENAI_API_KEY` | Optional | pgvector embeddings in RAG |
| `LANGFUSE_SECRET_KEY` | Optional | Trace forwarding to Langfuse |
| `MLFLOW_TRACKING_URI` | Optional | Experiment forwarding to MLflow |
| `GCP_PROJECT` | Optional | Vertex AI deployment |
| `GITHUB_REPO` | Optional | `corverxis/nexgen` — enables GitHub MCP panel in lab |

---

## GitHub MCP Server (connect the lab to this repo)

In the Frontier Lab → **MCP Servers** module, register:

| Field | Value |
|---|---|
| Name | `github` |
| URL | `npx -y @modelcontextprotocol/server-github` |
| Type | `stdio` |

Then in Render → Environment, add:
```
GITHUB_PERSONAL_ACCESS_TOKEN=ghp_...   (GitHub → Settings → Developer settings → Personal access tokens)
```

This gives your lab's AI assistant direct read/write access to this repo — it can read training records, open PRs, trigger workflows, and push changes.

---

## Triggering a training run from the lab

In the lab → **Scripts** module, the `Generate Training Data` script calls your backend API to build records. Once you have enough approved records:

1. Go to **GitHub → Actions → Training Pipeline → Run workflow**
2. Select tier (flash / pro / ultra)
3. The workflow validates the data, runs training, uploads the checkpoint, and logs the experiment run back to the lab automatically via the `LAB_URL` secret.

---

## Product ↔ Lab API

Once a checkpoint is trained and `training/serve.py` is running on GPU infrastructure, update the product frontend:

```js
// In product/index.html — change this line:
var NEXGEN_API_BASE = window.NEXGEN_API_BASE || 'http://localhost:8000';
// to:
var NEXGEN_API_BASE = 'https://your-inference-server.onrender.com';
```

Push to `product/` → GitHub Actions auto-deploys the updated product to Render.

---

## Where to fine-tune the NexGen model

The training pipeline in `training/` produces LoRA adapter weights on top of open-weight Qwen base models. Training happens **once per model version** on a rented GPU — the resulting checkpoint then serves every customer request indefinitely at near-zero marginal cost.

### Two operating phases

```
Phase 1 — Today (Anthropic powers responses)
────────────────────────────────────────────────────────────────────
Customer API call → server.js → Anthropic Claude API → response

  You pay Anthropic:   ~$0.003 / 1K input tokens
  You charge customer:  $0.003 / 1K input tokens  (Flash tier)
  Margin:              output token markup + subscription fees

Phase 2 — After fine-tuning (your GPU powers responses)
────────────────────────────────────────────────────────────────────
Customer API call → server.js → serve.py on RunPod GPU → response

  You pay RunPod:      ~$0.0005–0.001 / 1K tokens  (H100 at $2/hr)
  You charge customer:  $0.003 / 1K tokens
  Margin:              3–6× higher — this is where NexGen is profitable
```

One environment variable controls which phase the lab uses:

```env
# Phase 1 — Anthropic handles inference
ANTHROPIC_API_KEY=sk-ant-...

# Phase 2 — your fine-tuned Qwen model handles inference
NEXGEN_INFERENCE_URL=https://your-runpod-endpoint.runpod.net
```

When `NEXGEN_INFERENCE_URL` is set, `server.js` routes all `/v1/*` calls to `serve.py` instead of Anthropic.

---

### GPU platforms for training

| Platform | Best for | Cost per run | Notes |
|---|---|---|---|
| **Google Colab** | Testing (free) | $0 | Free T4 — Flash only, limited hours |
| **RunPod** | Flash & Pro production | $3–50 | Rent H100/A100 by the hour |
| **Lambda Labs** | Ultra (8×H100) | $300–800 | Distributed training for 397B model |
| **HuggingFace AutoTrain** | No-code quick start | $5–30 | Upload JSONL, click train |

### Training cost by tier

| Model | Hardware | Training time | Estimated cost |
|---|---|---|---|
| **Flash** — Qwen 3.5-9B | 1× A100 (40GB) | 2–4 hours | **$3–8** |
| **Pro** — Qwen 3.6-35B MoE | 2× A100 (80GB) | 6–10 hours | **$20–50** |
| **Ultra** — Qwen 3.5-397B MoE | 8× H100 (640GB) | 24–48 hours | **$300–800** |

A Flash fine-tune costs ~$8 and earns that back after roughly 1,000 customer API calls.

---

### Recommended order

**Step 1 — Test on Google Colab (free)**

```python
# In a Colab notebook:
!git clone https://github.com/corverxis/nexgen
%cd nexgen
!pip install -r training/requirements.txt
!python training/train_lora.py --config training/config_flash.yaml
```

Verify the training loop works and loss decreases before spending money.

**Step 2 — Fine-tune Flash on RunPod (~$5–8)**

1. Go to [runpod.io](https://runpod.io) → **Deploy** → pick an **A100 40GB** pod
2. Choose the **RunPod PyTorch** template (pre-installs CUDA + PyTorch)
3. Open the pod terminal:

```bash
git clone https://github.com/corverxis/nexgen
cd nexgen
pip install -r training/requirements.txt
export HF_TOKEN=hf_...          # HuggingFace token for saving checkpoint
python training/train_lora.py --config training/config_flash.yaml
```

4. Checkpoint saves automatically to HuggingFace Hub
5. **Stop the pod** — billing stops immediately

**Step 3 — Deploy serve.py as always-on inference**

On a separate RunPod GPU (kept running):

```bash
pip install -r training/requirements.txt
python training/serve.py \
  --model Qwen/Qwen3.5-9B-Instruct \
  --adapter ./checkpoints/nexgen-flash-v1 \
  --port 8000
```

RunPod provides a public HTTPS URL. Copy that URL.

**Step 4 — Point the lab at your model**

In Render → nexgen-frontier-lab → Environment:

```
NEXGEN_INFERENCE_URL = https://your-pod-id-8000.proxy.runpod.net
```

All `/v1/chat/completions` calls now route to Qwen on RunPod instead of Anthropic. Phase 2 is live.

**Step 5 — Fine-tune Pro once Flash is profitable**

Pro (35B MoE) needs 2× A100. Same process with `config_pro.yaml`. Ultra (397B MoE) needs a Lambda Labs 8×H100 cluster — run only when you have enough Ultra-tier subscribers to justify the cost.

---

### Triggering training from the Frontier Lab

The lab's **Training Jobs** module and **GitHub Actions** are already wired. Once you have ≥100 approved training records:

1. Frontier Lab → **Training Jobs** → queue a job for any tier
2. This triggers GitHub → Actions → Training Pipeline → Run workflow
3. The workflow validates the dataset, runs `train_lora.py`, uploads the checkpoint as a GitHub Actions artifact, and POSTs the experiment run back to the lab's **Experiments** module

To use a self-hosted GPU runner (so training actually runs on a real GPU):

1. On your RunPod pod, install the GitHub Actions runner:
```bash
mkdir actions-runner && cd actions-runner
curl -o runner.tar.gz -L \
  https://github.com/actions/runner/releases/download/v2.317.0/actions-runner-linux-x64-2.317.0.tar.gz
tar xzf runner.tar.gz
./config.sh --url https://github.com/corverxis/nexgen --token YOUR_RUNNER_TOKEN
./run.sh
```
2. In `.github/workflows/training.yml`, change:
```yaml
# Before (GitHub-hosted, no GPU):
runs-on: ubuntu-latest

# After (your RunPod with real GPU):
runs-on: [self-hosted, gpu]
```
3. Training now runs on your GPU automatically when triggered from the lab

---

## Billing & credits

### How credits are provisioned to serve customers

Credits are a pre-paid dollar balance stored in Postgres on each customer account. When a customer buys credits, Stripe processes their card, the money goes to Corverxis's bank account, and the customer's `creditBalance` field is incremented. Every API call decrements it.

```
Customer pays $50 → Stripe → Corverxis bank account
                           → customer.creditBalance += $55 (10% bonus)

Every API call:
  server.js → runs inference (Anthropic or serve.py)
            → counts tokens used
            → creditBalance -= (tokens × cost_per_token)

When creditBalance = 0 → API returns HTTP 402 → customer sees /pricing.html
```

Token cost rates:

| Model | Input | Output |
|---|---|---|
| Flash | $0.003 / 1M tokens | $0.015 / 1M tokens |
| Pro | $0.015 / 1M tokens | $0.075 / 1M tokens |
| Ultra | $0.060 / 1M tokens | $0.300 / 1M tokens |
| Embeddings | $0.001 / 1M tokens | — |

### Plans vs credits

| | Subscription plan | Credit top-up |
|---|---|---|
| What it is | Monthly token allowance | Pre-paid dollar balance |
| Resets | Every billing cycle | Never expires |
| Used first | Yes — plan tokens consumed before credits | Only after plan tokens exhausted |
| Auto-reload | N/A | Optional — auto-charges card when balance < threshold |

### Credit purchase discounts

| Amount paid | Discount | Credits received |
|---|---|---|
| $50 | Save 10% | $55 value |
| $100 | Save 10% | $111 value |
| $250 | Save 20% | $313 value |
| $1,000 | Save 30% | $1,429 value |

### Stripe setup (3 env vars in Render)

1. Create account at [stripe.com](https://stripe.com)
2. Get keys from Stripe Dashboard → Developers → API keys
3. Create webhook pointing at `https://your-lab.onrender.com/api/billing/webhook`
4. Add to Render → nexgen-frontier-lab → Environment:

```
STRIPE_SECRET_KEY      = sk_live_...
STRIPE_WEBHOOK_SECRET  = whsec_...
APP_URL                = https://nexgen-frontier-lab.onrender.com
```

The billing routes in `server.js` handle Checkout Sessions, webhook events (payment confirmation, subscription updates, auto-reload), and the Stripe Customer Portal. The pricing page is at `product/pricing.html`.
