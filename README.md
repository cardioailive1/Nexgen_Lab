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
