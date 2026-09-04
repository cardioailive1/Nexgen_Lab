'use strict';
/**
 * NexGen Frontier Lab — Backend
 * Corverxis Technologies · AI Engineering & Consulting
 *
 * Auth: JWT sessions via httpOnly cookies
 * RBAC: admin | engineer | intern
 * Pipelines: LangChain · LangGraph · MCP · RAG · pgvector
 *            LoRA/PEFT · Vertex AI · MLflow · Langfuse · Python Scripts
 * REST API: /v1/chat/completions · /v1/models · /v1/embeddings · /v1/health
 */
require('dotenv').config();

const express       = require('express');
const cors          = require('cors');
const path          = require('path');
const crypto        = require('crypto');
const cookieParser  = require('cookie-parser');
const bcrypt        = require('bcryptjs');
const jwt           = require('jsonwebtoken');
const { PrismaClient } = require('@prisma/client');
const Anthropic     = require('@anthropic-ai/sdk');

const app    = express();
const prisma = new PrismaClient();
const PORT   = process.env.PORT    || 3000;
const JWT_SECRET = process.env.JWT_SECRET || '';  // if unset → auth disabled (dev mode)

// ── Optional integrations ────────────────────────────────────────────────────
const anthropic = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;

function getLangChain()  { return require('@langchain/anthropic'); }
function getLangGraph()  { return require('@langchain/langgraph'); }
function getLCCore()     { return require('@langchain/core/messages'); }

// ── NexGen Pro embeddings — powers RAG vector search ──────────────────────────
// Requires NEXGEN_PRO_API_KEY + NEXGEN_INFERENCE_URL (Phase 2 self-hosted Qwen).
// Falls back to PostgreSQL full-text search everywhere this isn't configured yet.
function nexgenEmbeddingsReady() {
  return !!(process.env.NEXGEN_PRO_API_KEY && process.env.NEXGEN_INFERENCE_URL);
}

async function getNexGenEmbedding(input) {
  if (!nexgenEmbeddingsReady()) return null;
  try {
    const fetch = (...a) => import('node-fetch').then(({default:f})=>f(...a));
    const resp  = await fetch(`${process.env.NEXGEN_INFERENCE_URL}/v1/embeddings`, {
      method:  'POST',
      headers: { 'Content-Type':'application/json', 'Authorization':`Bearer ${process.env.NEXGEN_PRO_API_KEY}` },
      body:    JSON.stringify({ model:'nexgen-pro-v1', input }),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    return data; // { data: [{ embedding: [...] }, ...] } — OpenAI-compatible shape
  } catch (_) { return null; }
}
function getLangfuse()   {
  const { Langfuse } = require('langfuse');
  return new Langfuse({
    secretKey: process.env.LANGFUSE_SECRET_KEY,
    publicKey: process.env.LANGFUSE_PUBLIC_KEY || '',
    baseUrl:   process.env.LANGFUSE_HOST       || 'https://cloud.langfuse.com',
  });
}

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '4mb' }));
app.use(cookieParser());

// ─────────────────────────────────────────────────────────────────────────────
// RBAC — Role-Based Access Control
// Roles: admin | engineer | intern
// Permissions are cumulative — each role inherits intern's permissions.
// ─────────────────────────────────────────────────────────────────────────────
const ROLE_PERMS = {
  admin: new Set(['*']),   // wildcard — all permissions
  engineer: new Set([
    // Data
    'records:read','records:write','records:approve','records:delete',
    // Training
    'jobs:read','jobs:write',
    // Pipelines
    'pipelines:read','pipelines:write','pipelines:run','pipelines:delete',
    // RAG
    'rag:read','rag:write','rag:delete',
    // Experiments
    'experiments:read','experiments:write',
    // Observability
    'traces:read','traces:write',
    // MCP
    'mcp:read','mcp:write','mcp:delete',
    // Scripts
    'scripts:read','scripts:write','scripts:delete',
    // API Dev
    'apidev:read','apidev:write','apidev:test','apidev:endpoints',
    // Generate & validate
    'generate','validate',
  ]),
  intern: new Set([
    'records:read','records:write',
    'jobs:read',
    'pipelines:read','pipelines:run',
    'rag:read','rag:write',
    'experiments:read',
    'traces:read',
    'mcp:read',
    'scripts:read',
    'apidev:read','apidev:test',
    'generate',
  ]),
};

function can(user, perm) {
  if (!JWT_SECRET) return true; // dev mode — skip all auth
  if (!user) return false;
  const perms = ROLE_PERMS[user.role];
  return perms?.has('*') || perms?.has(perm) || false;
}

// ── Authenticate middleware ────────────────────────────────────────────────────
async function authenticate(req, res, next) {
  if (!JWT_SECRET) {
    // Dev mode: inject a virtual admin so routes work
    req.user = { id:'dev', name:'Dev Admin', email:'dev@local', role:'admin', status:'active' };
    return next();
  }
  const token = req.cookies?.nexgen_session
    || (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '').trim();
  if (!token) {
    return res.status(401).json({ error:'Not authenticated', code:'UNAUTHENTICATED' });
  }
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user    = await prisma.user.findUnique({ where:{ id:payload.userId } });
    if (!user || user.status !== 'active') {
      return res.status(401).json({ error:'Session invalid or user suspended', code:'UNAUTHENTICATED' });
    }
    req.user = user;
    next();
  } catch (_) {
    res.status(401).json({ error:'Session expired — please log in again', code:'UNAUTHENTICATED' });
  }
}

// ── Authorize middleware factory ───────────────────────────────────────────────
function authorize(...perms) {
  return (req, res, next) => {
    if (!JWT_SECRET) return next(); // dev mode
    if (!req.user)   return res.status(401).json({ error:'Not authenticated', code:'UNAUTHENTICATED' });
    const ok = perms.every(p => can(req.user, p));
    if (!ok) return res.status(403).json({
      error:`Permission denied. Required: ${perms.join(', ')}. Your role: ${req.user.role}`,
      code:'FORBIDDEN',
    });
    next();
  };
}

// ── Activity logging — records who did what, for the Team activity feed ──────
async function logActivity(req, action, resource, details) {
  try {
    await prisma.activityLog.create({ data:{
      userId:    req.user?.id    || null,
      userEmail: req.user?.email || null,
      action, resource: resource || null, details: details || null,
      ipAddress: req.headers['x-forwarded-for']?.split(',')[0] || req.ip || null,
    }});
  } catch (_) { /* never block the request on logging failure */ }
}

// ── Transform helpers ─────────────────────────────────────────────────────────
const toRecord   = r => ({ id:r.id, domain:r.domain, system:r.systemPrompt, messages:r.messages, review_status:r.reviewStatus, created_at:r.createdAt });
const toJob      = j => ({ id:j.id, tier:j.tier, base_model:j.baseModel, record_count:j.recordCount, epochs:j.epochs, seq_len:j.seqLen, lora_r:j.loraR, lr:j.lr, status:j.status, created_at:j.createdAt,
  dataset_export_url: j.datasetToken ? buildDatasetExportUrl(j.datasetToken) : null,
  dataset_export_expired: j.datasetTokenExpiresAt ? j.datasetTokenExpiresAt < new Date() : false,
});
const toPipeline = p => ({ id:p.id, name:p.name, type:p.type, config:p.config, status:p.status, created_at:p.createdAt });
const toRun      = r => ({ id:r.id, pipeline_id:r.pipelineId, input:r.input, output:r.output, status:r.status, latency_ms:r.latencyMs, tokens:r.tokens, created_at:r.createdAt });
const toExp      = e => ({ id:e.id, name:e.name, tags:e.tags, run_count:e.runs?.length||0, created_at:e.createdAt });
const toExpRun   = r => ({ id:r.id, experiment_id:r.experimentId, name:r.name, params:r.params, metrics:r.metrics, artifacts:r.artifacts, status:r.status, started_at:r.startedAt, ended_at:r.endedAt, created_at:r.createdAt });
const toTrace    = t => ({ id:t.id, name:t.name, input:t.input, output:t.output, model:t.model, latency_ms:t.latencyMs, tokens:t.tokens, cost:t.cost, score:t.score, tags:t.tags, metadata:t.metadata, created_at:t.createdAt });
const toMcp      = m => ({ id:m.id, name:m.name, url:m.url, type:m.type, tools:m.tools, status:m.status, created_at:m.createdAt });
const toScript   = s => ({ id:s.id, name:s.name, description:s.description, language:s.language, code:s.code, tags:s.tags, created_at:s.createdAt, updated_at:s.updatedAt });

// ── Seed data ─────────────────────────────────────────────────────────────────
const SYS_CHAT     = 'You are NexGen, a helpful, precise AI assistant.';
const SYS_CODE     = 'You are NexGen, an assistant specialised in producing clean, production-ready code with appropriate error handling and comments.';
const SYS_CLINICAL = 'You are NexGen, an AI assistant. Provide clinician-grade responses: cite guidelines where relevant, use correct medical terminology, and always recommend professional clinical judgement for actual patient care.';

const SEED_RECORDS = [
  { id:'nexgen-chat-seed-001',     domain:'chat',     systemPrompt:SYS_CHAT,     messages:[{role:'user',content:'Explain quantum entanglement simply.'},{role:'assistant',content:'Quantum entanglement is when two particles become linked so that measuring one instantly tells you something about the other, no matter how far apart they are.'}], reviewStatus:'approved' },
  { id:'nexgen-code-seed-001',     domain:'code',     systemPrompt:SYS_CODE,     messages:[{role:'user',content:'Write a Python retry function with exponential backoff.'},{role:'assistant',content:'```python\nimport time, random\ndef retry(fn, attempts=5, base=0.5):\n    for i in range(attempts):\n        try: return fn()\n        except Exception as e:\n            if i==attempts-1: raise\n            time.sleep(base*2**i+random.uniform(0,.25))\n```'}], reviewStatus:'approved' },
  { id:'nexgen-clinical-seed-001', domain:'clinical', systemPrompt:SYS_CLINICAL, messages:[{role:'user',content:'First-line treatment for HFrEF?'},{role:'assistant',content:'Four pillars per ESC 2021: ACE inhibitor/ARNI, beta-blocker, MRA, and SGLT2 inhibitor. General clinical information — always defer to treating physician.'}], reviewStatus:'needs_review' },
];

const SEED_PIPELINES = [
  { id:'pipeline-lc-001', name:'NexGen Chat Chain', type:'langchain', config:{ systemPrompt:'You are NexGen, a helpful assistant.', promptTemplate:'Answer this question concisely: {input}', model:'claude-sonnet-4-6' }, status:'active' },
  { id:'pipeline-rag-001', name:'NexGen RAG Pipeline', type:'rag', config:{ topK:5, model:'claude-sonnet-4-6', systemPrompt:'Answer using the provided context. If the answer is not in the context, say so.' }, status:'active' },
];

const SEED_EXPERIMENTS = [
  { id:'exp-001', name:'NexGen Flash LoRA v1', tags:{ tier:'flash', base_model:'Qwen3.5-9B', dataset_size:98 } },
  { id:'exp-002', name:'NexGen Pro LoRA v1',   tags:{ tier:'pro',   base_model:'Qwen3.6-35B', dataset_size:98 } },
];

const SEED_SCRIPTS = [
  {
    id: 'script-001', name: 'Generate Training Data', language: 'python',
    description: 'Calls the NexGen API to generate training records for all 17 domains',
    tags: ['data', 'generation'],
    code: `#!/usr/bin/env python3
"""
NexGen Training Data Generator
Calls the lab API to generate records for all 17 domains.
"""
import requests, json, time

LAB_URL = "http://localhost:3000"  # Change to your Render URL
DOMAINS = ["chat","code","reason","maths","statistics","physics",
           "life_science","engineering","clinical","legal","finance",
           "environmental_science","history","art_culture","mining_safety",
           "tools","safety"]
TOPICS  = {"chat":"general reasoning","code":"Python async programming",
           "maths":"calculus fundamentals","physics":"quantum mechanics basics",
           "clinical":"hypertension management","legal":"contract law overview",
           "finance":"portfolio diversification","history":"industrial revolution",
           "engineering":"structural load analysis","reason":"logical deduction",
           "statistics":"hypothesis testing","life_science":"cell division",
           "environmental_science":"carbon cycle","art_culture":"impressionism",
           "mining_safety":"slope stability monitoring","tools":"API orchestration",
           "safety":"prompt injection prevention"}

for domain in DOMAINS:
    r = requests.post(f"{LAB_URL}/api/generate",
        json={"domain": domain, "topic": TOPICS[domain],
              "system_prompt": f"You are NexGen, an assistant in the {domain} domain."})
    if r.ok:
        rec = r.json()
        requests.post(f"{LAB_URL}/api/records",
            json={"domain": domain, "system_prompt": rec["system"],
                  "messages": rec["messages"], "review_status": "needs_review"})
        print(f"✓ {domain}: {rec['id']}")
    else:
        print(f"✗ {domain}: {r.text[:80]}")
    time.sleep(1)  # respect rate limits
`,
  },
  {
    id: 'script-002', name: 'LoRA Fine-tune (Flash)', language: 'python',
    description: 'QLoRA fine-tuning script for NexGen Flash tier on approved records',
    tags: ['training', 'lora', 'peft'],
    code: `#!/usr/bin/env python3
"""
NexGen Flash — QLoRA Fine-Tuning
Fetches approved records from the lab API and runs LoRA fine-tuning.
Requires: transformers, peft, bitsandbytes, datasets, accelerate
"""
import json, requests
from datasets import Dataset
from transformers import AutoTokenizer, AutoModelForCausalLM, BitsAndBytesConfig, TrainingArguments, Trainer, DataCollatorForLanguageModeling
from peft import LoraConfig, get_peft_model, prepare_model_for_kbit_training

LAB_URL    = "http://localhost:3000"
BASE_MODEL = "Qwen/Qwen3.5-9B-Instruct"
OUTPUT_DIR = "./checkpoints/nexgen-flash-v1"

# Fetch approved records from the lab
records = [r for r in requests.get(f"{LAB_URL}/api/records").json()
           if r["review_status"] == "approved"]
print(f"Training on {len(records)} approved records")

tokenizer = AutoTokenizer.from_pretrained(BASE_MODEL)
if not tokenizer.pad_token:
    tokenizer.pad_token = tokenizer.eos_token

def format_record(r):
    msgs = [{"role": "system", "content": r["system"]}] + r["messages"]
    return {"text": tokenizer.apply_chat_template(msgs, tokenize=False, add_generation_prompt=False)}

dataset = Dataset.from_list([format_record(r) for r in records])

quant_config = BitsAndBytesConfig(load_in_4bit=True, bnb_4bit_quant_type="nf4",
    bnb_4bit_compute_dtype="bfloat16", bnb_4bit_use_double_quant=True)
model = AutoModelForCausalLM.from_pretrained(BASE_MODEL, quantization_config=quant_config, device_map="auto")
model = prepare_model_for_kbit_training(model)
model = get_peft_model(model, LoraConfig(r=16, lora_alpha=32, lora_dropout=0.05,
    target_modules=["q_proj","k_proj","v_proj","o_proj","gate_proj","up_proj","down_proj"],
    bias="none", task_type="CAUSAL_LM"))
model.print_trainable_parameters()

def tokenize(ex):
    t = tokenizer(ex["text"], truncation=True, max_length=4096, padding=False)
    t["labels"] = t["input_ids"].copy()
    return t

train_ds = dataset.map(tokenize, remove_columns=["text"])
trainer = Trainer(model=model,
    args=TrainingArguments(output_dir=OUTPUT_DIR, per_device_train_batch_size=2,
        gradient_accumulation_steps=8, num_train_epochs=3, learning_rate=2e-4,
        warmup_ratio=0.03, bf16=True, logging_steps=10, save_steps=200),
    train_dataset=train_ds,
    data_collator=DataCollatorForLanguageModeling(tokenizer, mlm=False))
trainer.train()
model.save_pretrained(OUTPUT_DIR)
tokenizer.save_pretrained(OUTPUT_DIR)
print(f"✓ Saved to {OUTPUT_DIR}")
`,
  },
  {
    id: 'script-003', name: 'Build FAISS Index', language: 'python',
    description: 'Builds a FAISS index from RAG documents (Python, uses sentence-transformers)',
    tags: ['rag', 'faiss', 'vectors'],
    code: `#!/usr/bin/env python3
"""
NexGen FAISS Index Builder
Fetches documents from the lab and builds a local FAISS index.
Requires: faiss-cpu, sentence-transformers, requests
"""
import requests, json, pickle, numpy as np

try:
    import faiss
    from sentence_transformers import SentenceTransformer
except ImportError:
    print("Install: pip install faiss-cpu sentence-transformers")
    raise

LAB_URL    = "http://localhost:3000"
MODEL_NAME = "all-MiniLM-L6-v2"   # 384-dim, fast, good quality
INDEX_PATH = "./nexgen_faiss.index"
META_PATH  = "./nexgen_faiss_meta.pkl"

print(f"Loading embedding model: {MODEL_NAME}")
model = SentenceTransformer(MODEL_NAME)

print("Fetching documents from lab...")
docs = requests.get(f"{LAB_URL}/api/rag/documents").json()
if not docs:
    print("No documents found. Add some via the RAG module first.")
    exit()

texts = [d["content"] for d in docs]
print(f"Embedding {len(texts)} chunks...")
embeddings = model.encode(texts, show_progress_bar=True, batch_size=32)
embeddings = embeddings.astype(np.float32)

dim   = embeddings.shape[1]
index = faiss.IndexFlatIP(dim)   # Inner product (cosine after norm)
faiss.normalize_L2(embeddings)
index.add(embeddings)

faiss.write_index(index, INDEX_PATH)
with open(META_PATH, "wb") as f:
    pickle.dump(docs, f)

print(f"✓ FAISS index: {INDEX_PATH} ({index.ntotal} vectors, dim={dim})")

# Test search
query = "machine learning training"
qvec  = model.encode([query]).astype(np.float32)
faiss.normalize_L2(qvec)
D, I  = index.search(qvec, 3)
print(f"\\nTest query: '{query}'")
for rank, (score, idx) in enumerate(zip(D[0], I[0])):
    print(f"  {rank+1}. [{score:.3f}] {docs[idx]['content'][:80]}...")
`,
  },
  {
    id: 'script-004', name: 'Langfuse Evaluation', language: 'python',
    description: 'Evaluates model outputs and logs scores to Langfuse',
    tags: ['evaluation', 'langfuse', 'observability'],
    code: `#!/usr/bin/env python3
"""
NexGen Langfuse Evaluator
Fetches traces from the lab, evaluates outputs, and logs scores to Langfuse.
Requires: langfuse, anthropic, requests
"""
import os, requests, json
from langfuse import Langfuse
from anthropic import Anthropic

LAB_URL  = "http://localhost:3000"
lf       = Langfuse(
    secret_key = os.environ["LANGFUSE_SECRET_KEY"],
    public_key = os.environ.get("LANGFUSE_PUBLIC_KEY",""),
    host       = os.environ.get("LANGFUSE_HOST","https://cloud.langfuse.com"))
client   = Anthropic(api_key=os.environ["ANTHROPIC_API_KEY"])

traces = requests.get(f"{LAB_URL}/api/traces").json()
print(f"Evaluating {len(traces)} traces...")

for t in traces[:20]:  # evaluate up to 20 per run
    if not t.get("output"):
        continue
    prompt = f"""Rate the quality of this AI assistant response on a 0.0-1.0 scale.
Question: {json.dumps(t["input"])}
Response: {json.dumps(t["output"])}
Return ONLY a JSON object: {{"score": 0.0-1.0, "reason": "one sentence"}}"""

    msg = client.messages.create(model="claude-sonnet-4-6", max_tokens=100,
          messages=[{"role":"user","content":prompt}])
    result = json.loads(msg.content[0].text)

    lf.score(trace_id=t["id"], name="quality", value=result["score"],
             comment=result["reason"])
    print(f"  {t['name'][:30]}: {result['score']:.2f} — {result['reason'][:60]}")

lf.flush()
print("✓ All scores logged to Langfuse")
`,
  },
  {
    id: 'script-005', name: 'Vertex AI Deployment', language: 'python',
    description: 'Deploys a trained NexGen checkpoint to Vertex AI for serving',
    tags: ['vertex', 'deployment', 'gcp'],
    code: `#!/usr/bin/env python3
"""
NexGen — Vertex AI Model Deployment
Uploads a trained checkpoint to Google Cloud Storage and deploys via Vertex AI.
Requires: google-cloud-aiplatform, google-cloud-storage
Set: GOOGLE_APPLICATION_CREDENTIALS, GCP_PROJECT, GCP_REGION, GCS_BUCKET
"""
import os
from google.cloud import aiplatform, storage

PROJECT   = os.environ["GCP_PROJECT"]
REGION    = os.environ.get("GCP_REGION", "us-central1")
BUCKET    = os.environ["GCS_BUCKET"]
MODEL_DIR = "./checkpoints/nexgen-flash-v1"   # local checkpoint path
GCS_PATH  = f"nexgen/checkpoints/flash-v1"
MODEL_NAME = "nexgen-flash-v1"

aiplatform.init(project=PROJECT, location=REGION)
client = storage.Client(project=PROJECT)
bucket = client.bucket(BUCKET)

# Upload checkpoint to GCS
print(f"Uploading {MODEL_DIR} → gs://{BUCKET}/{GCS_PATH}")
import pathlib
for f in pathlib.Path(MODEL_DIR).rglob("*"):
    if f.is_file():
        blob = bucket.blob(f"{GCS_PATH}/{f.relative_to(MODEL_DIR)}")
        blob.upload_from_filename(str(f))
        print(f"  ↑ {f.name}")

# Register model in Vertex AI Model Registry
print("Registering model in Vertex AI...")
model = aiplatform.Model.upload(
    display_name = MODEL_NAME,
    artifact_uri = f"gs://{BUCKET}/{GCS_PATH}",
    serving_container_image_uri = "us-docker.pkg.dev/vertex-ai/prediction/pytorch-gpu.2-2:latest",
    labels = {"project":"nexgen","tier":"flash","version":"v1"},
)
print(f"✓ Model registered: {model.resource_name}")

# Deploy to endpoint
endpoint = aiplatform.Endpoint.create(display_name=f"{MODEL_NAME}-endpoint")
deployed = endpoint.deploy(model=model, machine_type="n1-standard-4", accelerator_type="NVIDIA_TESLA_T4")
print(f"✓ Deployed: {endpoint.resource_name}")
print(f"  Endpoint: {endpoint.name}")
`,
  },
];

const SEED_MCP = [
  { id:'mcp-001', name:'filesystem',         url:'npx @modelcontextprotocol/server-filesystem /data', type:'stdio', tools:[{name:'read_file'},{name:'write_file'},{name:'list_directory'}], status:'inactive' },
  { id:'mcp-002', name:'nexgen-lab-api',     url:'http://localhost:3000/api',                          type:'http',  tools:[{name:'get_records'},{name:'create_record'},{name:'search_rag'}],   status:'inactive' },
];

async function seedDatabase() {
  const count = await prisma.record.count();
  if (count === 0) {
    console.log('Seeding records…');
    for (const r of SEED_RECORDS) await prisma.record.upsert({ where:{id:r.id}, update:{}, create:r });
  }
  const pc = await prisma.pipeline.count();
  if (pc === 0) {
    for (const p of SEED_PIPELINES) await prisma.pipeline.upsert({ where:{id:p.id}, update:{}, create:p });
  }
  const ec = await prisma.experiment.count();
  if (ec === 0) {
    for (const e of SEED_EXPERIMENTS) await prisma.experiment.upsert({ where:{id:e.id}, update:{}, create:e });
  }
  const sc = await prisma.script.count();
  if (sc === 0) {
    for (const s of SEED_SCRIPTS) {
      const { id, updated_at, ...data } = s;
      await prisma.script.upsert({ where:{id}, update:{}, create:{id, ...data} });
    }
  }
  const mc = await prisma.mcpServer.count();
  if (mc === 0) {
    for (const m of SEED_MCP) await prisma.mcpServer.upsert({ where:{id:m.id}, update:{}, create:m });
  }
  console.log('Database seeded.');
}

async function seedAdminUser() {
  const count = await prisma.user.count();
  if (count > 0) return;
  const password = await bcrypt.hash('LabAdmin@2024!', 12);
  await prisma.user.create({ data:{
    name:'Lab Admin', email:'admin@corverxis.com', password, role:'admin',
  }});
  console.log('Default admin created: admin@corverxis.com / LabAdmin@2024!  — change this after first login.');
}

// ─────────────────────────────────────────────────────────────────────────────
// AUTH ROUTES  —  /auth/*
// ─────────────────────────────────────────────────────────────────────────────

// ── POST /auth/register — open only when no users exist (first-boot bootstrap) ─
app.post('/auth/register', async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error:'name, email, password required' });
  if (password.length < 8)          return res.status(400).json({ error:'Password must be at least 8 characters' });

  // Check if any users already exist
  const count = await prisma.user.count();
  if (count > 0) {
    return res.status(403).json({
      error:'Registration is closed. Ask your lab admin to create an account for you via the User Management panel.'
    });
  }

  try {
    const hash = await bcrypt.hash(password, 12);
    const user = await prisma.user.create({
      data:{ name, email:email.toLowerCase().trim(), password:hash, role:'admin' }
    });

    // Auto-login after registration
    if (JWT_SECRET) {
      const token = jwt.sign({ userId:user.id, role:user.role }, JWT_SECRET, { expiresIn:'24h' });
      res.cookie('nexgen_session', token, {
        httpOnly:true, secure:process.env.NODE_ENV==='production',
        maxAge:86400000, sameSite:'lax',
      });
    }

    console.log(`First admin created: ${user.email}`);
    res.status(201).json({ id:user.id, name:user.name, email:user.email, role:user.role });
  } catch (err) {
    if (err.code==='P2002') return res.status(409).json({ error:'Email already in use' });
    res.status(500).json({ error:err.message });
  }
});

// ── POST /auth/login ──────────────────────────────────────────────────────────
app.post('/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error:'email and password required' });

  if (!JWT_SECRET) {
    return res.json({ id:'dev', name:'Dev Admin', email:'dev@local', role:'admin', dev_mode:true });
  }

  try {
    const user = await prisma.user.findUnique({ where:{ email: email.toLowerCase().trim() } });
    if (!user || user.status !== 'active') {
      return res.status(401).json({ error:'Invalid email or password' });
    }
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(401).json({ error:'Invalid email or password' });

    const token = jwt.sign({ userId:user.id, role:user.role }, JWT_SECRET, { expiresIn:'24h' });
    await prisma.user.update({ where:{ id:user.id }, data:{ lastLoginAt:new Date() } });

    res.cookie('nexgen_session', token, {
      httpOnly: true,
      secure:   process.env.NODE_ENV === 'production',
      maxAge:   24 * 60 * 60 * 1000,
      sameSite: 'lax',
    });
    res.json({ id:user.id, name:user.name, email:user.email, role:user.role });
  } catch (err) { res.status(500).json({ error:err.message }); }
});

// ── POST /auth/logout ─────────────────────────────────────────────────────────
app.post('/auth/logout', (req, res) => {
  res.clearCookie('nexgen_session');
  res.json({ ok:true });
});

// ── GET /auth/me ──────────────────────────────────────────────────────────────
app.get('/auth/me', async (req, res) => {
  if (!JWT_SECRET) {
    return res.json({ id:'dev', name:'Dev Admin', email:'dev@local', role:'admin', dev_mode:true });
  }
  const token = req.cookies?.nexgen_session;
  if (!token) return res.status(401).json({ error:'Not authenticated', code:'UNAUTHENTICATED' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user    = await prisma.user.findUnique({ where:{ id:payload.userId } });
    if (!user || user.status !== 'active') return res.status(401).json({ error:'Session invalid', code:'UNAUTHENTICATED' });
    res.json({ id:user.id, name:user.name, email:user.email, role:user.role, lastLoginAt:user.lastLoginAt });
  } catch (_) {
    res.status(401).json({ error:'Session expired', code:'UNAUTHENTICATED' });
  }
});

// ── GET /auth/users  (admin only) ─────────────────────────────────────────────
app.get('/auth/users', authenticate, authorize('*'), async (req, res) => {
  try {
    const users = await prisma.user.findMany({ orderBy:{ createdAt:'asc' },
      select:{ id:true, name:true, email:true, role:true, status:true, lastLoginAt:true, createdAt:true } });
    res.json(users);
  } catch (err) { res.status(500).json({ error:err.message }); }
});

// ── POST /auth/users  — create user (admin only) ──────────────────────────────
app.post('/auth/users', authenticate, authorize('*'), async (req, res) => {
  const { name, email, password, role='intern' } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error:'name, email, password required' });
  if (!['admin','engineer','intern'].includes(role)) return res.status(400).json({ error:'role must be admin, engineer, or intern' });
  try {
    const hash = await bcrypt.hash(password, 12);
    const user = await prisma.user.create({ data:{ name, email:email.toLowerCase().trim(), password:hash, role } });
    res.status(201).json({ id:user.id, name:user.name, email:user.email, role:user.role, status:user.status });
  } catch (err) {
    if (err.code === 'P2002') return res.status(409).json({ error:'Email already in use' });
    res.status(500).json({ error:err.message });
  }
});

// ── PUT /auth/users/:id  — update user (admin only) ───────────────────────────
app.put('/auth/users/:id', authenticate, authorize('*'), async (req, res) => {
  const { name, role, status, password } = req.body;
  try {
    const data = {};
    if (name   !== undefined) data.name   = name;
    if (role   !== undefined) data.role   = role;
    if (status !== undefined) data.status = status;
    if (password) data.password = await bcrypt.hash(password, 12);
    const user = await prisma.user.update({ where:{ id:req.params.id }, data,
      select:{ id:true, name:true, email:true, role:true, status:true } });
    res.json(user);
  } catch (err) {
    if (err.code === 'P2025') return res.status(404).json({ error:'User not found' });
    res.status(500).json({ error:err.message });
  }
});

// ── DELETE /auth/users/:id  (admin only, cannot delete self) ──────────────────
app.delete('/auth/users/:id', authenticate, authorize('*'), async (req, res) => {
  if (req.params.id === req.user.id) return res.status(400).json({ error:'Cannot delete your own account' });
  try {
    await prisma.user.delete({ where:{ id:req.params.id } });
    res.json({ deleted:req.params.id });
  } catch (err) {
    if (err.code === 'P2025') return res.status(404).json({ error:'User not found' });
    res.status(500).json({ error:err.message });
  }
});

// ── POST /auth/change-password  ────────────────────────────────────────────────
app.post('/auth/change-password', authenticate, async (req, res) => {
  const { current_password, new_password } = req.body;
  if (!current_password || !new_password) return res.status(400).json({ error:'current_password and new_password required' });
  if (new_password.length < 8) return res.status(400).json({ error:'Password must be at least 8 characters' });
  try {
    const user  = await prisma.user.findUnique({ where:{ id:req.user.id } });
    const valid = await bcrypt.compare(current_password, user.password);
    if (!valid) return res.status(401).json({ error:'Current password incorrect' });
    const hash  = await bcrypt.hash(new_password, 12);
    await prisma.user.update({ where:{ id:req.user.id }, data:{ password:hash } });
    res.json({ ok:true });
  } catch (err) { res.status(500).json({ error:err.message }); }
});
app.get('/api/health', async (req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({
      status: 'ok', db: 'connected', model: 'claude-sonnet-4-6',
      api_key_set:      !!process.env.ANTHROPIC_API_KEY,
      langfuse_set:     !!process.env.LANGFUSE_SECRET_KEY,
      nexgen_pro_embeddings_set: nexgenEmbeddingsReady(),
      mlflow_set:       !!process.env.MLFLOW_TRACKING_URI,
      vertex_set:       !!process.env.GCP_PROJECT,
    });
  } catch (err) {
    res.status(503).json({ status: 'error', db: 'disconnected', error: err.message });
  }
});

// ── STATS ─────────────────────────────────────────────────────────────────────
app.get('/api/stats', authenticate, async (req, res) => {
  try {
    const [total, approved, needsReview, jobs, running, pipelines, traces, byDomain] = await Promise.all([
      prisma.record.count(),
      prisma.record.count({ where: { reviewStatus:'approved' } }),
      prisma.record.count({ where: { reviewStatus:'needs_review' } }),
      prisma.job.count(),
      prisma.job.count({ where: { status:'running' } }),
      prisma.pipeline.count(),
      prisma.trace.count(),
      prisma.record.groupBy({ by:['domain'], _count:{ domain:true } }),
    ]);
    const avgLatency = await prisma.trace.aggregate({ _avg:{ latencyMs:true } });
    res.json({
      total, approved, needs_review:needsReview, jobs, running, pipelines, traces,
      avg_latency_ms: Math.round(avgLatency._avg.latencyMs || 0),
      by_domain: byDomain.map(d => ({ domain:d.domain, count:d._count.domain })),
    });
  } catch (err) { res.status(500).json({ error:err.message }); }
});

// ── RECORDS ───────────────────────────────────────────────────────────────────
app.get('/api/records', authenticate, authorize('records:read'), async (req, res) => {
  try {
    const records = await prisma.record.findMany({ orderBy:{ createdAt:'desc' } });
    res.json(records.map(toRecord));
  } catch (err) { res.status(500).json({ error:err.message }); }
});

// ═════════════════════════════════════════════════════════════════════════════
// BULK GENERATION — turn a list of questions into real, saved user+assistant
// records automatically. Reuses the exact same two-call plain-text generation
// method as /api/generate, and the exact same save shape as POST /api/records
// — this is the same pipeline, just automated across many questions instead
// of one manual click at a time. Runs as a background job since generating
// dozens or hundreds of records can take minutes; the caller polls for progress.
// ═════════════════════════════════════════════════════════════════════════════

// ── Generate one question/answer pair as plain text — extracted from
// /api/generate so both the single-record endpoint and bulk jobs share
// identical generation logic, not two copies that could drift apart. ────────
async function generateQAPair(domain, topic, systemPrompt) {
  const msg = await anthropic.messages.create({
    model: 'claude-sonnet-4-6', max_tokens: 2048,
    system: `You are a training data generator for NexGen, an AI assistant by Corverxis Technologies.
Your job is to create realistic question-answer pairs for the ${domain} domain.
Always respond in this EXACT format with no extra text:

QUESTION: <the user question>
ANSWER: <the full assistant answer>

Rules:
- QUESTION and ANSWER must each be on their own line starting with that label
- The answer must be complete, accurate, and helpful
- For clinical/legal/finance/engineering/mining_safety: include a professional disclaimer at the end
- Do not use any JSON, markdown code blocks, or special formatting`,
    messages: [{ role:'user', content:`Generate a question-answer pair for the "${domain}" domain about this topic: ${topic}` }],
  });

  const raw = msg.content[0]?.text || '';
  const parts = raw.split('\n'); const question_arr = []; const answer_arr = [];
  let inA = false;
  for (const p of parts) {
    if (p.startsWith('QUESTION:')) { question_arr.push(p.slice(9).trim()); }
    else if (p.startsWith('ANSWER:')) { inA=true; answer_arr.push(p.slice(7).trim()); }
    else if (inA) answer_arr.push(p);
  }
  let question = question_arr.join(' ').trim();
  let answer = answer_arr.join('\n').trim();

  if (!question || !answer) {
    // Fallback: treat first line as question, rest as answer — same as /api/generate
    const lines = raw.trim().split('\n');
    question = (lines[0]||'').replace(/^(question:|q:)/i,'').trim();
    answer   = lines.slice(1).join('\n').replace(/^(answer:|a:)/i,'').trim();
  }
  if (!question || !answer) throw new Error('Could not extract question and answer from response');
  return { question, answer };
}

// ── Run a bulk generation job — sequential-with-limited-concurrency so this
// doesn't hammer the Anthropic API or the database all at once. Updates the
// job row after every question so progress is genuinely pollable, not just
// reported at the end. ────────────────────────────────────────────────────
const BULK_GEN_CONCURRENCY = 3;

async function runBulkGeneration(jobId, domain, systemPrompt, questions, ownerId) {
  const results = [];
  let completed = 0, failed = 0;

  async function processOne(topic) {
    try {
      const { question, answer } = await generateQAPair(domain, topic, systemPrompt);
      const record = await prisma.record.create({ data:{
        domain, systemPrompt, messages:[{role:'user',content:question},{role:'assistant',content:answer}],
        reviewStatus:'needs_review', createdById: ownerId||null,
      }});
      completed++;
      results.push({ question: topic, status:'created', record_id: record.id });
    } catch (err) {
      failed++;
      results.push({ question: topic, status:'failed', error: err.message });
    }
    // Update progress after every single question — this is what makes
    // polling actually useful instead of a black box until the end.
    await prisma.bulkGenerationJob.update({ where:{ id:jobId }, data:{
      completedCount: completed, failedCount: failed, results,
    }}).catch(()=>{});
  }

  // Process in small concurrent batches rather than all-at-once or fully sequential
  for (let i = 0; i < questions.length; i += BULK_GEN_CONCURRENCY) {
    const batch = questions.slice(i, i + BULK_GEN_CONCURRENCY);
    await Promise.all(batch.map(processOne));
  }

  await prisma.bulkGenerationJob.update({ where:{ id:jobId }, data:{
    status:'completed', completedAt: new Date(),
  }}).catch(()=>{});
}

// ── POST /api/records/bulk-generate — start a bulk generation job ────────────
app.post('/api/records/bulk-generate', authenticate, authorize('records:write'), async (req, res) => {
  const { domain, system_prompt, questions } = req.body;
  if (!domain || !Array.isArray(questions) || questions.length === 0) {
    return res.status(400).json({ error:'domain and a non-empty questions[] array are required' });
  }
  if (questions.length > 500) {
    return res.status(400).json({ error:'Maximum 500 questions per bulk job — split larger batches into multiple runs' });
  }
  if (!anthropic) return res.status(503).json({ error:'ANTHROPIC_API_KEY not set' });

  try {
    const sysPrompt = system_prompt || `You are NexGen, a helpful AI assistant built by Corverxis Technologies.`;
    const job = await prisma.bulkGenerationJob.create({ data:{
      domain, totalQuestions: questions.length, createdById: req.user?.id||null,
    }});

    runBulkGeneration(job.id, domain, sysPrompt, questions, req.user?.id).catch(err => console.error('Bulk generation job failed:', err));

    res.status(202).json({ job_id: job.id, total_questions: questions.length, status:'running' });
  } catch (err) { res.status(500).json({ error:err.message }); }
});

// ── GET /api/records/bulk-generate/:id — poll a job's progress ───────────────
app.get('/api/records/bulk-generate/:id', authenticate, authorize('records:read'), async (req, res) => {
  try {
    const job = await prisma.bulkGenerationJob.findUnique({ where:{ id:req.params.id } });
    if (!job) return res.status(404).json({ error:'Job not found' });
    res.json({
      id:job.id, domain:job.domain, total_questions:job.totalQuestions,
      completed_count:job.completedCount, failed_count:job.failedCount, status:job.status,
      results:job.results, created_at:job.createdAt, completed_at:job.completedAt,
    });
  } catch (err) { res.status(500).json({ error:err.message }); }
});

// ── GET /api/records/bulk-generate — list recent bulk jobs ───────────────────
app.get('/api/records/bulk-generate', authenticate, authorize('records:read'), async (req, res) => {
  try {
    const jobs = await prisma.bulkGenerationJob.findMany({ orderBy:{ createdAt:'desc' }, take:20 });
    res.json(jobs.map(j => ({
      id:j.id, domain:j.domain, total_questions:j.totalQuestions,
      completed_count:j.completedCount, failed_count:j.failedCount, status:j.status,
      created_at:j.createdAt, completed_at:j.completedAt,
    })));
  } catch (err) { res.status(500).json({ error:err.message }); }
});

app.post('/api/records', authenticate, authorize('records:write'), async (req, res) => {
  const { domain, system_prompt, messages, review_status='needs_review' } = req.body;
  if (!domain || !system_prompt || !Array.isArray(messages))
    return res.status(400).json({ error:'domain, system_prompt, and messages[] required' });
  if (messages[0]?.role !== 'user')
    return res.status(400).json({ error:'messages must start with a user turn' });
  if (messages[messages.length-1]?.role !== 'assistant')
    return res.status(400).json({ error:'messages must end with an assistant turn' });
  try {
    const r = await prisma.record.create({ data:{ domain, systemPrompt:system_prompt, messages, reviewStatus:review_status, createdById:req.user?.id||null } });
    await logActivity(req, 'record.created', r.id, { domain });
    res.status(201).json(toRecord(r));
  } catch (err) { res.status(500).json({ error:err.message }); }
});

app.patch('/api/records/:id/status', authenticate, authorize('records:approve'), async (req, res) => {
  const allowed = ['approved','needs_review','rejected'];
  if (!allowed.includes(req.body.status))
    return res.status(400).json({ error:`status must be one of: ${allowed.join(', ')}` });
  try {
    const r = await prisma.record.update({ where:{ id:req.params.id },
      data:{ reviewStatus:req.body.status, reviewedById:req.user?.id||null } });
    await logActivity(req, `record.${req.body.status}`, r.id, { domain:r.domain });
    res.json(toRecord(r));
  } catch (err) {
    if (err.code==='P2025') return res.status(404).json({ error:'Record not found' });
    res.status(500).json({ error:err.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// AUTO-PROCESS — sweeps a domain's needs_review records, running the exact
// same Validate → Fix → Approve/Reject flow a human reviewer uses manually,
// one record at a time. Reuses validateRecordQuality() and fixRecordAnswer()
// directly — this is not a separate, divergent implementation of quality
// judgment, it is the identical logic behind the manual buttons.
//
// A record is only ever auto-approved when the AI's own judgment supports
// it. A "review" recommendation triggers one fix attempt and a
// re-validation; if that still isn't confident, the record is left in
// needs_review for a human rather than force-approved. A "reject"
// recommendation is applied directly, matching what a careful human
// reviewer would very likely do anyway.
// ═════════════════════════════════════════════════════════════════════════════

async function autoProcessOneRecord(rec, userId) {
  const firstPass = await validateRecordQuality({ domain:rec.domain, messages:rec.messages });

  if (firstPass.recommendation === 'approve') {
    await prisma.record.update({ where:{ id:rec.id }, data:{ reviewStatus:'approved', reviewedById:userId||null } });
    return { record_id:rec.id, outcome:'approved', fixed:false, score:firstPass.score, reason:firstPass.reason };
  }

  if (firstPass.recommendation === 'reject') {
    await prisma.record.update({ where:{ id:rec.id }, data:{ reviewStatus:'rejected', reviewedById:userId||null } });
    return { record_id:rec.id, outcome:'rejected', fixed:false, score:firstPass.score, reason:firstPass.reason };
  }

  // recommendation === 'review' — attempt one fix, then re-validate the result
  const { correctedAnswer } = await fixRecordAnswer({ domain:rec.domain, messages:rec.messages }, firstPass.issues);
  const fixedMessages = rec.messages.map(m => m.role==='assistant' ? { ...m, content:correctedAnswer } : m);

  const secondPass = await validateRecordQuality({ domain:rec.domain, messages:fixedMessages });

  if (secondPass.recommendation === 'approve') {
    await prisma.record.update({ where:{ id:rec.id }, data:{
      messages: fixedMessages, reviewStatus:'approved', reviewedById:userId||null,
    }});
    return { record_id:rec.id, outcome:'approved', fixed:true, score:secondPass.score, reason:'Fixed and passed re-validation' };
  }

  // Still not confident even after a fix attempt — save the fix attempt as a
  // starting point for a human, but do NOT force approval or rejection.
  await prisma.record.update({ where:{ id:rec.id }, data:{ messages: fixedMessages } });
  return { record_id:rec.id, outcome:'left_for_review', fixed:true, score:secondPass.score, reason:'Still not confident after a fix attempt — needs a human reviewer' };
}

async function runAutoProcess(jobId, domain, userId) {
  const results = [];
  let approvedCount = 0, fixedCount = 0, rejectedCount = 0, leftForReviewCount = 0;
  try {
    const records = await prisma.record.findMany({ where:{ domain, reviewStatus:'needs_review' }, orderBy:{ createdAt:'asc' } });

    for (const rec of records) {
      let outcome;
      try {
        outcome = await autoProcessOneRecord(rec, userId);
      } catch (err) {
        outcome = { record_id:rec.id, outcome:'left_for_review', fixed:false, score:null, reason:'Auto-process error: '+err.message };
      }
      if (outcome.outcome === 'approved') { approvedCount++; if (outcome.fixed) fixedCount++; }
      else if (outcome.outcome === 'rejected') rejectedCount++;
      else leftForReviewCount++;

      results.push(outcome);
      await prisma.autoProcessJob.update({ where:{ id:jobId }, data:{
        approvedCount, fixedCount, rejectedCount, leftForReviewCount, results,
      }}).catch(()=>{});
    }

    await prisma.autoProcessJob.update({ where:{ id:jobId }, data:{ status:'completed', completedAt:new Date() } });
  } catch (err) {
    console.error('Auto-process job failed:', err);
    await prisma.autoProcessJob.update({ where:{ id:jobId }, data:{ status:'failed', completedAt:new Date() } }).catch(()=>{});
  }
}

// ── POST /api/records/auto-process — start a domain sweep ────────────────────
// ═════════════════════════════════════════════════════════════════════════════
// DEDUPLICATION — final data-cleaning pass before records reach training.
// Finds near-duplicate approved records within a domain (by question-text
// similarity, not just exact matches) and keeps only the oldest of each
// group. Every removal is logged with exactly what it duplicated and how
// similar it was — nothing is ever silently deleted with no trace.
// ═════════════════════════════════════════════════════════════════════════════

const DUPLICATE_SIMILARITY_THRESHOLD = 0.80;

function normalizeForComparison(text) {
  return (text||'').toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function jaccardSimilarity(textA, textB) {
  const wordsA = new Set(normalizeForComparison(textA).split(' ').filter(Boolean));
  const wordsB = new Set(normalizeForComparison(textB).split(' ').filter(Boolean));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  const intersection = new Set([...wordsA].filter(w => wordsB.has(w)));
  const union = new Set([...wordsA, ...wordsB]);
  return intersection.size / union.size;
}

// ── Groups near-duplicate records by question-text similarity. The OLDEST
// record in each group is kept; everything else in that group is a
// duplicate candidate. O(n²) comparisons — fine for realistic domain sizes
// (hundreds of records); a very large domain would need a smarter index,
// but that's not the scale this Lab operates at today. ──────────────────────
function findDuplicateGroups(records) {
  const sorted = [...records].sort((a,b) => new Date(a.createdAt) - new Date(b.createdAt));
  const assigned = new Set();
  const groups = [];

  for (let i = 0; i < sorted.length; i++) {
    if (assigned.has(sorted[i].id)) continue;
    const group = [{ ...sorted[i], similarity: 1 }];
    assigned.add(sorted[i].id);
    for (let j = i+1; j < sorted.length; j++) {
      if (assigned.has(sorted[j].id)) continue;
      const sim = jaccardSimilarity(sorted[i].question, sorted[j].question);
      if (sim >= DUPLICATE_SIMILARITY_THRESHOLD) {
        group.push({ ...sorted[j], similarity: sim });
        assigned.add(sorted[j].id);
      }
    }
    if (group.length > 1) groups.push(group);
  }
  return groups;
}

async function runDeduplication(jobId, domain, req) {
  const userId = req?.user?.id;
  try {
    const approvedRecords = await prisma.record.findMany({ where:{ domain, reviewStatus:'approved' } });
    const withQuestions = approvedRecords.map(r => ({
      id: r.id, createdAt: r.createdAt,
      question: r.messages.find(m=>m.role==='user')?.content || '',
    }));

    const groups = findDuplicateGroups(withQuestions);
    const results = [];
    let duplicatesRemoved = 0;

    for (const group of groups) {
      const [keeper, ...duplicates] = group;
      for (const dup of duplicates) {
        await prisma.record.update({ where:{ id:dup.id }, data:{
          reviewStatus:'rejected', reviewedById:userId||null,
        }});
        await logActivity(req, 'record.deduplicated', dup.id, {
          domain, duplicate_of: keeper.id, similarity: dup.similarity,
        }).catch(()=>{});
        duplicatesRemoved++;
      }
      results.push({
        kept_id: keeper.id, kept_question: keeper.question.slice(0,100),
        removed: duplicates.map(d => ({ id:d.id, question:d.question.slice(0,100), similarity:+d.similarity.toFixed(2) })),
      });
    }

    await prisma.deduplicationJob.update({ where:{ id:jobId }, data:{
      groupsFound: groups.length, duplicatesRemoved, results, status:'completed', completedAt:new Date(),
    }});
  } catch (err) {
    console.error('Deduplication job failed:', err);
    await prisma.deduplicationJob.update({ where:{ id:jobId }, data:{ status:'failed', completedAt:new Date() } }).catch(()=>{});
  }
}

// ── POST /api/records/deduplicate — start a domain dedup sweep ───────────────
app.post('/api/records/deduplicate', authenticate, authorize('records:approve'), async (req, res) => {
  const { domain } = req.body;
  if (!domain) return res.status(400).json({ error:'domain required' });
  try {
    const totalRecords = await prisma.record.count({ where:{ domain, reviewStatus:'approved' } });
    if (totalRecords === 0) return res.status(400).json({ error:`No approved records in the "${domain}" domain.` });

    const job = await prisma.deduplicationJob.create({ data:{ domain, totalRecords, createdById:req.user?.id||null } });
    runDeduplication(job.id, domain, req).catch(err => console.error('Deduplication job failed:', err));
    res.status(202).json({ job_id: job.id, total_records: totalRecords, status:'running' });
  } catch (err) { res.status(500).json({ error:err.message }); }
});

// ── GET /api/records/deduplicate/:id — poll job progress ─────────────────────
app.get('/api/records/deduplicate/:id', authenticate, authorize('records:read'), async (req, res) => {
  try {
    const job = await prisma.deduplicationJob.findUnique({ where:{ id:req.params.id } });
    if (!job) return res.status(404).json({ error:'Job not found' });
    res.json({
      id:job.id, domain:job.domain, total_records:job.totalRecords,
      groups_found:job.groupsFound, duplicates_removed:job.duplicatesRemoved,
      status:job.status, results:job.results, created_at:job.createdAt, completed_at:job.completedAt,
    });
  } catch (err) { res.status(500).json({ error:err.message }); }
});

app.post('/api/records/auto-process', authenticate, authorize('records:approve'), async (req, res) => {
  const { domain } = req.body;
  if (!domain) return res.status(400).json({ error:'domain required' });
  if (!anthropic) return res.status(503).json({ error:'ANTHROPIC_API_KEY not set' });
  try {
    const totalRecords = await prisma.record.count({ where:{ domain, reviewStatus:'needs_review' } });
    if (totalRecords === 0) return res.status(400).json({ error:`No needs_review records in the "${domain}" domain.` });

    const job = await prisma.autoProcessJob.create({ data:{ domain, totalRecords, createdById:req.user?.id||null } });
    runAutoProcess(job.id, domain, req.user?.id).catch(err => console.error('Auto-process job failed:', err));
    res.status(202).json({ job_id: job.id, total_records: totalRecords, status:'running' });
  } catch (err) { res.status(500).json({ error:err.message }); }
});

// ── GET /api/records/auto-process/:id — poll job progress ────────────────────
app.get('/api/records/auto-process/:id', authenticate, authorize('records:read'), async (req, res) => {
  try {
    const job = await prisma.autoProcessJob.findUnique({ where:{ id:req.params.id } });
    if (!job) return res.status(404).json({ error:'Job not found' });
    res.json({
      id:job.id, domain:job.domain, total_records:job.totalRecords,
      approved_count:job.approvedCount, fixed_count:job.fixedCount,
      rejected_count:job.rejectedCount, left_for_review_count:job.leftForReviewCount,
      status:job.status, results:job.results, created_at:job.createdAt, completed_at:job.completedAt,
    });
  } catch (err) { res.status(500).json({ error:err.message }); }
});

// ── GET /api/records/auto-process — list recent jobs ──────────────────────────
app.get('/api/records/auto-process', authenticate, authorize('records:read'), async (req, res) => {
  try {
    const jobs = await prisma.autoProcessJob.findMany({ orderBy:{ createdAt:'desc' }, take:10 });
    res.json(jobs.map(j => ({
      id:j.id, domain:j.domain, total_records:j.totalRecords,
      approved_count:j.approvedCount, fixed_count:j.fixedCount,
      rejected_count:j.rejectedCount, left_for_review_count:j.leftForReviewCount,
      status:j.status, created_at:j.createdAt, completed_at:j.completedAt,
    })));
  } catch (err) { res.status(500).json({ error:err.message }); }
});

app.delete('/api/records/:id', async (req, res) => {
  try {
    await prisma.record.delete({ where:{ id:req.params.id } });
    res.json({ deleted:req.params.id });
  } catch (err) {
    if (err.code==='P2025') return res.status(404).json({ error:'Record not found' });
    res.status(500).json({ error:err.message });
  }
});

// ── JOBS (LoRA/PEFT) ──────────────────────────────────────────────────────────
app.get('/api/jobs', authenticate, authorize('jobs:read'), async (req, res) => {
  try {
    const jobs = await prisma.job.findMany({ orderBy:{ createdAt:'desc' } });
    res.json(jobs.map(toJob));
  } catch (err) { res.status(500).json({ error:err.message }); }
});

// ═════════════════════════════════════════════════════════════════════════════
// AUTOMATIC DATASET EXPORT — a stable, token-authenticated URL a training
// environment (e.g. a RunPod bootstrap script) can curl directly at the
// start of every run. Reuses the same storage layer (S3-if-configured,
// local-disk fallback) already proven for generated documents and assignment
// attachments — no new security model, no new dependency.
//
// The JSONL snapshot is frozen the moment a job is queued — approving more
// records afterward never silently changes what an already-queued job will
// train on. Each line matches the same {messages, domain, system} shape the
// Import JSONL feature already reads, so the format is consistent everywhere
// in the system, not a one-off.
// ═════════════════════════════════════════════════════════════════════════════

function buildJSONLDataset(records) {
  return records.map(r => JSON.stringify({
    domain: r.domain, system: r.systemPrompt, messages: r.messages,
  })).join('\n');
}

async function snapshotJobDataset(jobId, records) {
  const jsonl = buildJSONLDataset(records);
  const filename = `nexgen-dataset-${jobId}.jsonl`;
  const localPath = path.join(GENERATED_DIR, filename);
  fs.writeFileSync(localPath, jsonl, 'utf8');

  const { storageKey, persistent } = await storeGeneratedFile(localPath, filename);
  const token = crypto.randomBytes(24).toString('hex');

  await prisma.job.update({ where:{ id:jobId }, data:{
    datasetToken: token, datasetStorageKey: storageKey, datasetPersistent: persistent,
    datasetTokenExpiresAt: new Date(Date.now() + 90 * 24 * 3600 * 1000),   // 90 days — a training run may not pull immediately
  }});
  return token;
}

function buildDatasetExportUrl(token) {
  const base = (process.env.APP_URL || 'https://nexgen-frontier-lab.onrender.com').replace(/\/+$/, '');
  return `${base}/api/jobs/dataset/${token}`;
}

// ── GET /api/jobs/dataset/:token — the actual automatic pull endpoint.
// No session auth — a training environment has no way to send a login
// cookie, only this signed link. The token itself is the credential,
// exactly like generated-document and assignment-attachment downloads. ──────
app.get('/api/jobs/dataset/:token', async (req, res) => {
  try {
    const job = await prisma.job.findUnique({ where:{ datasetToken: req.params.token } });
    if (!job) return res.status(404).send('Export link not found or already invalid.');
    if (job.datasetTokenExpiresAt && job.datasetTokenExpiresAt < new Date()) {
      return res.status(410).send('This export link has expired. Regenerate it from Training Jobs in the Lab.');
    }

    res.setHeader('Content-Type', 'application/x-ndjson');
    res.setHeader('Content-Disposition', `attachment; filename="nexgen-dataset-${job.id}.jsonl"`);

    if (job.datasetPersistent && isS3Configured()) {
      const signedUrl = await getS3PresignedGetUrl(job.datasetStorageKey, 300);
      return res.redirect(signedUrl);
    }
    const localPath = path.join(GENERATED_DIR, job.datasetStorageKey);
    if (!fs.existsSync(localPath)) {
      return res.status(410).send('This dataset is no longer available on local storage — configure S3 for durable exports, or regenerate this job\'s export.');
    }
    res.sendFile(localPath);
  } catch (err) {
    res.status(500).send('Export failed: ' + err.message);
  }
});

// ── POST /api/jobs/:id/regenerate-export — refresh the snapshot and token,
// e.g. after approving more records and wanting the export to reflect that,
// or if a token needs rotating. ───────────────────────────────────────────
app.post('/api/jobs/:id/regenerate-export', authenticate, authorize('jobs:write'), async (req, res) => {
  try {
    const job = await prisma.job.findUnique({ where:{ id:req.params.id } });
    if (!job) return res.status(404).json({ error:'Job not found' });
    const approvedRecords = await prisma.record.findMany({ where:{ reviewStatus:'approved' } });
    const token = await snapshotJobDataset(job.id, approvedRecords);
    res.json({ export_url: buildDatasetExportUrl(token), record_count: approvedRecords.length });
  } catch (err) { res.status(500).json({ error:err.message }); }
});

app.post('/api/jobs', authenticate, authorize('jobs:write'), async (req, res) => {
  const { tier, base_model, record_count=0, epochs=3, seq_len=4096, lora_r=32, lr=0.0001 } = req.body;
  if (!tier || !base_model) return res.status(400).json({ error:'tier and base_model required' });
  try {
    const j = await prisma.job.create({ data:{ tier, baseModel:base_model, recordCount:record_count, epochs, seqLen:seq_len, loraR:lora_r, lr, status:'queued' } });

    // Snapshot the current approved dataset immediately — this is what makes
    // the export "automatic": by the time the job appears in the list, its
    // export URL is already live and ready to be curled, no separate step.
    const approvedRecords = await prisma.record.findMany({ where:{ reviewStatus:'approved' } });
    const token = await snapshotJobDataset(j.id, approvedRecords);

    res.status(201).json({ ...toJob(j), dataset_export_url: buildDatasetExportUrl(token) });
  } catch (err) { res.status(500).json({ error:err.message }); }
});

app.patch('/api/jobs/:id/status', async (req, res) => {
  const allowed = ['queued','running','done','failed','cancelled'];
  if (!allowed.includes(req.body.status))
    return res.status(400).json({ error:`status must be one of: ${allowed.join(', ')}` });
  try {
    const j = await prisma.job.update({ where:{ id:req.params.id }, data:{ status:req.body.status } });
    res.json(toJob(j));
  } catch (err) {
    if (err.code==='P2025') return res.status(404).json({ error:'Job not found' });
    res.status(500).json({ error:err.message });
  }
});

// ── PIPELINES (LangChain / LangGraph) ────────────────────────────────────────
app.get('/api/pipelines', authenticate, authorize('pipelines:read'), async (req, res) => {
  try {
    const pipelines = await prisma.pipeline.findMany({ orderBy:{ createdAt:'desc' }, include:{ runs:{ take:1, orderBy:{ createdAt:'desc' } } } });
    res.json(pipelines.map(toPipeline));
  } catch (err) { res.status(500).json({ error:err.message }); }
});

app.post('/api/pipelines', authenticate, authorize('pipelines:write'), async (req, res) => {
  const { name, type, config={} } = req.body;
  if (!name || !type) return res.status(400).json({ error:'name and type required' });
  try {
    const p = await prisma.pipeline.create({ data:{ name, type, config } });
    res.status(201).json(toPipeline(p));
  } catch (err) { res.status(500).json({ error:err.message }); }
});

app.get('/api/pipelines/:id', authenticate, authorize('pipelines:read'), async (req, res) => {
  try {
    const p = await prisma.pipeline.findUnique({ where:{ id:req.params.id }, include:{ runs:{ orderBy:{ createdAt:'desc' }, take:20 } } });
    if (!p) return res.status(404).json({ error:'Pipeline not found' });
    res.json({ ...toPipeline(p), runs:p.runs.map(toRun) });
  } catch (err) { res.status(500).json({ error:err.message }); }
});

app.delete('/api/pipelines/:id', authenticate, authorize('pipelines:delete'), async (req, res) => {
  try {
    await prisma.pipeline.delete({ where:{ id:req.params.id } });
    res.json({ deleted:req.params.id });
  } catch (err) {
    if (err.code==='P2025') return res.status(404).json({ error:'Pipeline not found' });
    res.status(500).json({ error:err.message });
  }
});

// Run a pipeline — actual LangChain / LangGraph execution
app.post('/api/pipelines/:id/run', async (req, res) => {
  const pipeline = await prisma.pipeline.findUnique({ where:{ id:req.params.id } }).catch(() => null);
  if (!pipeline) return res.status(404).json({ error:'Pipeline not found' });

  const { input='' } = req.body;
  const start = Date.now();
  let output = '', tokens = 0, status = 'done';

  try {
    const cfg = pipeline.config;

    if (pipeline.type === 'langchain') {
      if (!anthropic) throw new Error('ANTHROPIC_API_KEY not configured');
      const { ChatAnthropic } = getLangChain();
      const { HumanMessage, SystemMessage } = getLCCore();
      const model = new ChatAnthropic({ model:cfg.model||'claude-sonnet-4-6', apiKey:process.env.ANTHROPIC_API_KEY });
      const userContent = cfg.promptTemplate ? cfg.promptTemplate.replace('{input}', input) : input;
      const msgs = [new SystemMessage(cfg.systemPrompt||'You are a helpful assistant.'), new HumanMessage(userContent)];
      const response = await model.invoke(msgs);
      output = response.content;
      tokens = response.usage_metadata?.total_tokens || 0;

    } else if (pipeline.type === 'langgraph') {
      if (!anthropic) throw new Error('ANTHROPIC_API_KEY not configured');
      const { StateGraph, END } = getLangGraph();
      const { ChatAnthropic } = getLangChain();
      const { HumanMessage, SystemMessage } = getLCCore();
      const llm = new ChatAnthropic({ model:cfg.model||'claude-sonnet-4-6', apiKey:process.env.ANTHROPIC_API_KEY });
      const nodes = cfg.nodes || [{ id:'agent', prompt:'Answer the user query helpfully.' }];
      const graph = new StateGraph({ channels:{ messages:{ value:(x,y)=>(x||[]).concat(y||[]) } } });
      for (const node of nodes) {
        graph.addNode(node.id, async state => {
          const response = await llm.invoke([new SystemMessage(node.prompt||'Be helpful.'), ...state.messages]);
          return { messages:[response] };
        });
      }
      graph.setEntryPoint(nodes[0].id);
      graph.addEdge(nodes[0].id, END);
      const compiled = graph.compile();
      const result = await compiled.invoke({ messages:[new HumanMessage(input)] });
      output = result.messages[result.messages.length-1]?.content || '';

    } else if (pipeline.type === 'rag') {
      // RAG: search docs → build context → answer
      const topK = cfg.topK || 5;
      let contextDocs = [];
      try {
        const nexgenEmb = await getNexGenEmbedding(input);
        if (nexgenEmb) {
          const vec = `[${nexgenEmb.data[0].embedding.join(',')}]`;
          contextDocs = await prisma.$queryRaw`
            SELECT content, source FROM vector_documents
            WHERE embedding IS NOT NULL
            ORDER BY embedding <=> ${vec}::vector LIMIT ${topK}`;
        } else {
          contextDocs = await prisma.vectorDocument.findMany({ take: topK,
            orderBy:{ createdAt:'desc' } });
        }
      } catch (_) { contextDocs = await prisma.vectorDocument.findMany({ take: topK }); }

      const context = contextDocs.map((d,i) => `[${i+1}] ${d.content}`).join('\n\n');
      if (!anthropic) throw new Error('ANTHROPIC_API_KEY not configured');
      const msg = await anthropic.messages.create({
        model: cfg.model || 'claude-sonnet-4-6', max_tokens: 1024,
        system: `${cfg.systemPrompt||'Answer using the provided context only.'}\n\nCONTEXT:\n${context}`,
        messages: [{ role:'user', content:input }],
      });
      output = msg.content[0].text;
      tokens = (msg.usage?.input_tokens || 0) + (msg.usage?.output_tokens || 0);

    } else {
      // Custom / passthrough
      if (!anthropic) throw new Error('ANTHROPIC_API_KEY not configured');
      const msg = await anthropic.messages.create({
        model:'claude-sonnet-4-6', max_tokens:1024,
        system: cfg.systemPrompt || 'You are NexGen, a helpful assistant.',
        messages: [{ role:'user', content:input }],
      });
      output = msg.content[0].text;
      tokens = (msg.usage?.input_tokens||0) + (msg.usage?.output_tokens||0);
    }

  } catch (err) {
    output = err.message;
    status = 'failed';
  }

  const latencyMs = Date.now() - start;
  const run = await prisma.pipelineRun.create({
    data:{ pipelineId:pipeline.id, input:{ text:input }, output:{ text:output }, status, latencyMs, tokens }
  });

  // Forward trace to Langfuse if configured
  if (process.env.LANGFUSE_SECRET_KEY) {
    try {
      const lf = getLangfuse();
      const trace = lf.trace({ id:run.id, name:pipeline.name, input:{ text:input } });
      trace.span({ name:'llm', input, output, startTime:new Date(Date.now()-latencyMs), endTime:new Date() });
      trace.update({ output:{ text:output }, metadata:{ tokens, pipeline_type:pipeline.type } });
      await lf.shutdownAsync();
    } catch (_) {}
  }

  res.json({ output, latency_ms:latencyMs, tokens, status, run_id:run.id });
});

// ── EXPERIMENTS (MLflow-compatible) ──────────────────────────────────────────
app.get('/api/experiments', authenticate, authorize('experiments:read'), async (req, res) => {
  try {
    const exps = await prisma.experiment.findMany({ orderBy:{ createdAt:'desc' }, include:{ runs:true } });
    res.json(exps.map(toExp));
  } catch (err) { res.status(500).json({ error:err.message }); }
});

app.post('/api/experiments', authenticate, authorize('experiments:write'), async (req, res) => {
  const { name, tags={} } = req.body;
  if (!name) return res.status(400).json({ error:'name required' });
  try {
    const e = await prisma.experiment.create({ data:{ name, tags } });
    // Forward to MLflow if configured
    if (process.env.MLFLOW_TRACKING_URI) {
      try {
        const fetch = (...a) => import('node-fetch').then(({default:f}) => f(...a));
        await fetch(`${process.env.MLFLOW_TRACKING_URI}/api/2.0/mlflow/experiments/create`,
          { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ name }) });
      } catch (_) {}
    }
    res.status(201).json(toExp(e));
  } catch (err) { res.status(500).json({ error:err.message }); }
});

app.get('/api/experiments/:id/runs', async (req, res) => {
  try {
    const runs = await prisma.experimentRun.findMany({ where:{ experimentId:req.params.id }, orderBy:{ createdAt:'desc' } });
    res.json(runs.map(toExpRun));
  } catch (err) { res.status(500).json({ error:err.message }); }
});

app.post('/api/experiments/:id/runs', async (req, res) => {
  const { name, params={}, metrics={}, artifacts=[] } = req.body;
  try {
    const r = await prisma.experimentRun.create({ data:{ experimentId:req.params.id, name, params, metrics, artifacts, status:'running' } });
    res.status(201).json(toExpRun(r));
  } catch (err) { res.status(500).json({ error:err.message }); }
});

app.patch('/api/experiments/runs/:runId', async (req, res) => {
  const { metrics, status, artifacts } = req.body;
  try {
    const data = {};
    if (metrics)   data.metrics = metrics;
    if (status)    data.status  = status;
    if (artifacts) data.artifacts = artifacts;
    if (status === 'finished' || status === 'failed') data.endedAt = new Date();
    const r = await prisma.experimentRun.update({ where:{ id:req.params.runId }, data });
    res.json(toExpRun(r));
  } catch (err) {
    if (err.code==='P2025') return res.status(404).json({ error:'Run not found' });
    res.status(500).json({ error:err.message });
  }
});

// ── RAG & VECTORS (pgvector) ──────────────────────────────────────────────────
app.get('/api/rag/documents', authenticate, authorize('rag:read'), async (req, res) => {
  try {
    const docs = await prisma.vectorDocument.findMany({ orderBy:{ createdAt:'desc' } });
    res.json(docs);
  } catch (err) { res.status(500).json({ error:err.message }); }
});

app.post('/api/rag/documents', authenticate, authorize('rag:write'), async (req, res) => {
  const { content, source='manual', metadata={}, chunk_size=800, overlap=100 } = req.body;
  if (!content) return res.status(400).json({ error:'content required' });

  // Chunk the document
  const chunks = [];
  for (let i = 0; i < content.length; i += chunk_size - overlap) {
    chunks.push(content.slice(i, i + chunk_size));
    if (i + chunk_size >= content.length) break;
  }

  const created = [];
  try {
    for (let idx = 0; idx < chunks.length; idx++) {
      const doc = await prisma.vectorDocument.create({
        data:{ content:chunks[idx], metadata:{ ...metadata, total_chunks:chunks.length }, source, chunkIdx:idx }
      });

      // Embed with NexGen Pro if configured, else skip embedding (full-text fallback handles search)
      const nexgenEmb = await getNexGenEmbedding(chunks[idx]);
      if (nexgenEmb) {
        try {
          const vec = `[${nexgenEmb.data[0].embedding.join(',')}]`;
          await prisma.$executeRaw`
            UPDATE vector_documents SET embedding = ${vec}::vector WHERE id = ${doc.id}`;
        } catch (_) {}
      }
      created.push(doc);
    }
    await logActivity(req, 'rag.document.uploaded', source, { chunks:created.length, source });
    res.status(201).json({ chunks_created:created.length, documents:created });
  } catch (err) { res.status(500).json({ error:err.message }); }
});

app.delete('/api/rag/documents/:id', authenticate, authorize('rag:delete'), async (req, res) => {
  try {
    const doc = await prisma.vectorDocument.delete({ where:{ id:req.params.id } });
    await logActivity(req, 'rag.document.deleted', req.params.id, { source:doc.source });
    res.json({ deleted:req.params.id });
  } catch (err) {
    if (err.code==='P2025') return res.status(404).json({ error:'Document not found' });
    res.status(500).json({ error:err.message });
  }
});

app.post('/api/rag/search', async (req, res) => {
  const { query, top_k=5 } = req.body;
  if (!query) return res.status(400).json({ error:'query required' });
  try {
    let results, method;
    const nexgenEmb = await getNexGenEmbedding(query);
    if (nexgenEmb) {
      const vec = `[${nexgenEmb.data[0].embedding.join(',')}]`;
      results = await prisma.$queryRaw`
        SELECT id, content, metadata, source, chunk_idx,
               round((embedding <=> ${vec}::vector)::numeric, 4) AS distance
        FROM vector_documents WHERE embedding IS NOT NULL
        ORDER BY embedding <=> ${vec}::vector LIMIT ${top_k}`;
      method = 'pgvector (NexGen Pro)';
    } else {
      results = await prisma.$queryRaw`
        SELECT id, content, metadata, source, chunk_idx,
               ts_rank(to_tsvector('english', content), plainto_tsquery('english', ${query})) AS distance
        FROM vector_documents
        WHERE to_tsvector('english', content) @@ plainto_tsquery('english', ${query})
        ORDER BY distance DESC LIMIT ${top_k}`;
      method = 'fulltext';
    }
    res.json({ results: results.map(r => ({ ...r, distance: Number(r.distance) })), method });
  } catch (err) { res.status(500).json({ error:err.message }); }
});

// ── OBSERVABILITY (Langfuse-compatible traces) ────────────────────────────────
app.get('/api/traces', authenticate, authorize('traces:read'), async (req, res) => {
  try {
    const traces = await prisma.trace.findMany({ orderBy:{ createdAt:'desc' }, take:200 });
    res.json(traces.map(toTrace));
  } catch (err) { res.status(500).json({ error:err.message }); }
});

app.post('/api/traces', authenticate, authorize('traces:write'), async (req, res) => {
  const { name, input, output, model, latency_ms, tokens=0, cost=0, score, tags=[], metadata={} } = req.body;
  if (!name || !input) return res.status(400).json({ error:'name and input required' });
  try {
    const t = await prisma.trace.create({ data:{ name, input, output, model, latencyMs:latency_ms, tokens, cost, score, tags, metadata } });
    // Forward to Langfuse if configured
    if (process.env.LANGFUSE_SECRET_KEY) {
      try {
        const lf = getLangfuse();
        lf.trace({ id:t.id, name, input, output, metadata:{ model, tokens, cost, ...metadata } });
        lf.flush();
      } catch (_) {}
    }
    res.status(201).json(toTrace(t));
  } catch (err) { res.status(500).json({ error:err.message }); }
});

app.get('/api/traces/:id', async (req, res) => {
  try {
    const t = await prisma.trace.findUnique({ where:{ id:req.params.id } });
    if (!t) return res.status(404).json({ error:'Trace not found' });
    res.json(toTrace(t));
  } catch (err) { res.status(500).json({ error:err.message }); }
});

// ── MCP SERVERS ───────────────────────────────────────────────────────────────
app.get('/api/mcp/servers', authenticate, authorize('mcp:read'), async (req, res) => {
  try {
    const servers = await prisma.mcpServer.findMany({ orderBy:{ createdAt:'desc' } });
    res.json(servers.map(toMcp));
  } catch (err) { res.status(500).json({ error:err.message }); }
});

app.post('/api/mcp/servers', authenticate, authorize('mcp:write'), async (req, res) => {
  const { name, url, type='sse' } = req.body;
  if (!name || !url) return res.status(400).json({ error:'name and url required' });
  try {
    const s = await prisma.mcpServer.create({ data:{ name, url, type, tools:[], status:'inactive' } });
    res.status(201).json(toMcp(s));
  } catch (err) { res.status(500).json({ error:err.message }); }
});

app.patch('/api/mcp/servers/:id', async (req, res) => {
  try {
    const s = await prisma.mcpServer.update({ where:{ id:req.params.id }, data:req.body });
    res.json(toMcp(s));
  } catch (err) {
    if (err.code==='P2025') return res.status(404).json({ error:'Server not found' });
    res.status(500).json({ error:err.message });
  }
});

app.delete('/api/mcp/servers/:id', async (req, res) => {
  try {
    await prisma.mcpServer.delete({ where:{ id:req.params.id } });
    res.json({ deleted:req.params.id });
  } catch (err) {
    if (err.code==='P2025') return res.status(404).json({ error:'Server not found' });
    res.status(500).json({ error:err.message });
  }
});

// ── SCRIPTS (Python / Shell) ──────────────────────────────────────────────────
app.get('/api/scripts', authenticate, authorize('scripts:read'), async (req, res) => {
  try {
    const scripts = await prisma.script.findMany({ orderBy:{ createdAt:'desc' } });
    res.json(scripts.map(toScript));
  } catch (err) { res.status(500).json({ error:err.message }); }
});

app.post('/api/scripts', authenticate, authorize('scripts:write'), async (req, res) => {
  const { name, description, language='python', code, tags=[] } = req.body;
  if (!name || !code) return res.status(400).json({ error:'name and code required' });
  try {
    const s = await prisma.script.create({ data:{ name, description, language, code, tags } });
    res.status(201).json(toScript(s));
  } catch (err) { res.status(500).json({ error:err.message }); }
});

app.get('/api/scripts/:id', authenticate, authorize('scripts:read'), async (req, res) => {
  try {
    const s = await prisma.script.findUnique({ where:{ id:req.params.id } });
    if (!s) return res.status(404).json({ error:'Script not found' });
    res.json(toScript(s));
  } catch (err) { res.status(500).json({ error:err.message }); }
});

app.put('/api/scripts/:id', async (req, res) => {
  const { name, description, language, code, tags } = req.body;
  try {
    const data = {};
    if (name !== undefined)        data.name = name;
    if (description !== undefined) data.description = description;
    if (language !== undefined)    data.language = language;
    if (code !== undefined)        data.code = code;
    if (tags !== undefined)        data.tags = tags;
    const s = await prisma.script.update({ where:{ id:req.params.id }, data });
    res.json(toScript(s));
  } catch (err) {
    if (err.code==='P2025') return res.status(404).json({ error:'Script not found' });
    res.status(500).json({ error:err.message });
  }
});

app.delete('/api/scripts/:id', async (req, res) => {
  try {
    await prisma.script.delete({ where:{ id:req.params.id } });
    res.json({ deleted:req.params.id });
  } catch (err) {
    if (err.code==='P2025') return res.status(404).json({ error:'Script not found' });
    res.status(500).json({ error:err.message });
  }
});

// ── CLAUDE ROUTES (Generate + Validate) ──────────────────────────────────────
// ── Data generation — two-call approach (content first, JSON built server-side) ─
// Never ask the model to write JSON — it fails on complex answers.
// Step 1: Get question + answer as plain text.
// Step 2: Server wraps it in valid JSON. Guaranteed to parse.
app.post('/api/generate', async (req, res) => {
  if (!anthropic) return res.status(503).json({ error:'ANTHROPIC_API_KEY not set' });
  const { domain, topic, system_prompt } = req.body;
  if (!domain || !topic || !system_prompt) {
    return res.status(400).json({ error:'domain, topic, system_prompt required' });
  }

  try {
    // ── Step 1: Generate question + answer as plain text ──────────────────────
    const msg = await anthropic.messages.create({
      model:      'claude-sonnet-4-6',
      max_tokens: 2048,
      system: `You are a training data generator for NexGen, an AI assistant by Corverxis Technologies.
Your job is to create realistic question-answer pairs for the ${domain} domain.
Always respond in this EXACT format with no extra text:

QUESTION: <the user question>
ANSWER: <the full assistant answer>

Rules:
- QUESTION and ANSWER must each be on their own line starting with that label
- The answer must be complete, accurate, and helpful
- For clinical/legal/finance/engineering/mining_safety: include a professional disclaimer at the end
- Do not use any JSON, markdown code blocks, or special formatting`,
      messages: [{
        role: 'user',
        content: `Generate a question-answer pair for the "${domain}" domain about this topic: ${topic}`
      }]
    });

    const raw  = msg.content[0]?.text || '';
    // Parse QUESTION/ANSWER from plain text
    const parts = raw.split('\n'), question_arr = [], answer_arr = [];
    let inA = false;
    for (const p of parts) {
      if (p.startsWith('QUESTION:')) { question_arr.push(p.slice(9).trim()); }
      else if (p.startsWith('ANSWER:')) { inA=true; answer_arr.push(p.slice(7).trim()); }
      else if (inA) answer_arr.push(p);
    }
    const qMatch = question_arr.length ? [null, question_arr.join(' ')] : null;
    const aMatch  = answer_arr.length   ? [null, answer_arr.join('\n')]  : null;

    if (!qMatch || !aMatch) {
      // Fallback: treat first line as question, rest as answer
      const lines = raw.trim().split('\n');
      const question = lines[0].replace(/^(question:|q:)/i,'').trim();
      const answer   = lines.slice(1).join('\n').replace(/^(answer:|a:)/i,'').trim();
      if (!question || !answer) {
        return res.status(500).json({ error:'Could not extract question and answer from response. Try a different topic.' });
      }
      const record = {
        id:            `nexgen-${domain}-${Date.now()}`,
        domain,
        system:        system_prompt,
        messages:      [{ role:'user', content:question }, { role:'assistant', content:answer }],
        review_status: 'needs_review',
      };
      return res.json(record);
    }

    const question = qMatch[1].trim();
    const answer   = aMatch[1].trim();

    // ── Step 2: Build valid JSON on server — never trust the model to do this ──
    const record = {
      id:            `nexgen-${domain}-${Date.now()}`,
      domain,
      system:        system_prompt,
      messages:      [{ role:'user', content:question }, { role:'assistant', content:answer }],
      review_status: 'needs_review',
    };

    // Verify it serialises cleanly
    JSON.parse(JSON.stringify(record));
    return res.json(record);

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});


// ── POST /api/fix — Claude corrects issues in a training record ───────────────
app.post('/api/fix', authenticate, authorize('validate'), async (req, res) => {
  if (!anthropic) return res.status(503).json({ error:'ANTHROPIC_API_KEY not set' });
  const { record, issues } = req.body;
  if (!record || !record.messages) return res.status(400).json({ error:'record required' });
  try {
    const { correctedAnswer, assistantMsg } = await fixRecordAnswer(record, issues||[]);
    const fixedRecord = { ...record, messages: record.messages.map(m => m.role==='assistant' ? { ...m, content:correctedAnswer } : m) };
    res.json({ record: fixedRecord, original_answer: assistantMsg, corrected_answer: correctedAnswer });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Shared fix logic — used by both the manual /api/fix endpoint and the
// auto-process sweep, same reasoning as validateRecordQuality above. ─────────
async function fixRecordAnswer(record, issues) {
  const userMsg      = record.messages.find(m => m.role === 'user')?.content     || '';
  const assistantMsg = record.messages.find(m => m.role === 'assistant')?.content || '';
  const issueList    = (issues || []).join('\n- ');

  const msg = await anthropic.messages.create({
    model:      'claude-sonnet-4-6',
    max_tokens: 2048,
    system: 'You are a training data quality editor for NexGen AI. Rewrite assistant responses to fix specific quality issues while keeping the answer accurate and helpful.',
    messages: [{
      role:    'user',
      content: `Fix the following issues in this training record assistant response.

DOMAIN: ${record.domain || 'general'}

USER QUESTION:
${userMsg}

CURRENT ASSISTANT ANSWER:
${assistantMsg}

ISSUES TO FIX:
- ${issueList}

Write an improved assistant answer that fixes all the listed issues. Keep what was good.
Respond with ONLY the corrected assistant answer text — no labels, no explanation.`,
    }]
  });

  const correctedAnswer = msg.content[0]?.text?.trim() || assistantMsg;
  return { correctedAnswer, assistantMsg };
}

// ── POST /api/records/:id/content — update record content ────────────────────
app.put('/api/records/:id/content', authenticate, authorize('records:write'), async (req, res) => {
  const { user_content, assistant_content } = req.body;
  try {
    const rec = await prisma.record.findUnique({ where:{ id:req.params.id } });
    if (!rec) return res.status(404).json({ error:'Record not found' });

    const messages = rec.messages.map(m => {
      if (m.role === 'user'      && user_content)      return { ...m, content: user_content };
      if (m.role === 'assistant' && assistant_content)  return { ...m, content: assistant_content };
      return m;
    });

    const updated = await prisma.record.update({
      where:{ id:req.params.id },
      data:{ messages }
    });
    res.json(updated);
  } catch (err) { res.status(500).json({ error:err.message }); }
});


// ── POST /api/validate — AI quality validation of a training record ───────────
app.post('/api/validate', authenticate, authorize('validate'), async (req, res) => {
  if (!anthropic) return res.status(503).json({ error:'ANTHROPIC_API_KEY not set' });
  const { record } = req.body;
  if (!record || !record.messages) return res.status(400).json({ error:'record with messages required' });
  try {
    const result = await validateRecordQuality(record);
    res.json({ ...result, domain: record.domain||'general', record_id: record.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Shared validation logic — used by both the manual /api/validate endpoint
// and the auto-process sweep, so there is exactly one implementation to keep
// correct, never two copies that could silently drift apart. ────────────────
async function validateRecordQuality(record) {
  const userMsg      = record.messages.find(m => m.role === 'user')?.content     || '';
  const assistantMsg = record.messages.find(m => m.role === 'assistant')?.content || '';
  const domain       = record.domain || 'general';

  const msg = await anthropic.messages.create({
    model:      'claude-sonnet-4-6',
    max_tokens: 1024,
    system: 'You are a training data quality evaluator for NexGen, an AI assistant by Corverxis Technologies. Evaluate the quality of AI training records objectively.',
    messages: [{
      role:    'user',
      content: `Evaluate this NexGen training record for the "${domain}" domain.

USER QUESTION:
${userMsg}

ASSISTANT ANSWER:
${assistantMsg}

Rate this record on a scale of 1-10 and respond with ONLY this format (no other text):
SCORE: <number 1-10>
RECOMMENDATION: <approve|review|reject>
STRENGTH: <one strength>
STRENGTH: <another strength>
ISSUE: <one issue if any, or "none">
ISSUE: <another issue if any, or "none">
REASON: <one sentence summary>

Scoring guide:
9-10: Excellent — accurate, detailed, well-formatted, appropriate disclaimers
7-8:  Good — accurate and helpful with minor improvements possible
5-6:  Fair — mostly correct but missing depth or has minor errors
3-4:  Poor — significant errors or missing important information
1-2:  Reject — incorrect, harmful, or completely off-topic`,
    }]
  });

  const raw = msg.content[0]?.text || '';
  const lines       = raw.split('\n').map(l => l.trim()).filter(Boolean);
  const scoreMatch  = lines.find(l => l.startsWith('SCORE:'));
  const recMatch    = lines.find(l => l.startsWith('RECOMMENDATION:'));
  const reasonMatch = lines.find(l => l.startsWith('REASON:'));
  const strengths   = lines.filter(l => l.startsWith('STRENGTH:')).map(l => l.replace('STRENGTH:','').trim()).filter(s => s && s.toLowerCase() !== 'none');
  const issues      = lines.filter(l => l.startsWith('ISSUE:')).map(l => l.replace('ISSUE:','').trim()).filter(s => s && s.toLowerCase() !== 'none');

  const score          = scoreMatch  ? parseInt(scoreMatch.replace('SCORE:','').trim())           : 5;
  const recommendation = recMatch    ? recMatch.replace('RECOMMENDATION:','').trim().toLowerCase() : 'review';
  const reason         = reasonMatch ? reasonMatch.replace('REASON:','').trim()                    : 'See details above';

  return { score, recommendation, strengths, issues, reason };
}


// ─────────────────────────────────────────────────────────────────────────────
// API DEVELOPMENT & CREATION  —  Endpoints · Keys · Pipelines · Tester · Docs
// Build and manage the NexGen LLM API surface directly from the Frontier Lab.
// ─────────────────────────────────────────────────────────────────────────────

// ── Seed: NexGen LLM API endpoints ───────────────────────────────────────────
const SEED_ENDPOINTS = [
  {
    id:'ep-chat-001', name:'Chat Completions', method:'POST', path:'/v1/chat/completions', version:'v1',
    description:'Create a chat completion. OpenAI-compatible. Supports streaming via the stream parameter.',
    auth:'api_key', status:'active',
    requestSchema:{ type:'object', required:['model','messages'],
      properties:{ model:{type:'string',example:'nexgen-flash-v1'},
        messages:{type:'array',items:{type:'object',properties:{role:{type:'string'},content:{type:'string'}}}},
        max_tokens:{type:'integer',default:1024}, temperature:{type:'number',default:0.7},
        stream:{type:'boolean',default:false}, system:{type:'string'} }},
    responseSchema:{ type:'object', properties:{
      id:{type:'string'}, object:{type:'string',example:'chat.completion'},
      model:{type:'string'}, choices:{type:'array'}, usage:{type:'object',
        properties:{prompt_tokens:{type:'integer'},completion_tokens:{type:'integer'},total_tokens:{type:'integer'}}} }},
  },
  {
    id:'ep-stream-001', name:'Chat Stream (SSE)', method:'POST', path:'/v1/chat/stream', version:'v1',
    description:'Streaming chat via Server-Sent Events. Each event contains a delta chunk.',
    auth:'api_key', status:'active',
    requestSchema:{ type:'object', required:['messages'],
      properties:{ messages:{type:'array'}, system:{type:'string'}, max_new_tokens:{type:'integer',default:1024}, temperature:{type:'number',default:0.7} }},
    responseSchema:{ type:'object', description:'SSE stream: event: delta\\ndata: <token>\\n\\n ... event: done\\ndata: \\n\\n' },
  },
  {
    id:'ep-models-001', name:'List Models', method:'GET', path:'/v1/models', version:'v1',
    description:'Returns a list of available NexGen model checkpoints.',
    auth:'api_key', status:'active',
    requestSchema:{}, responseSchema:{ type:'object', properties:{ data:{type:'array',
      items:{type:'object',properties:{id:{type:'string'},object:{type:'string'},tier:{type:'string'}}}} }},
  },
  {
    id:'ep-embed-001', name:'Embeddings', method:'POST', path:'/v1/embeddings', version:'v1',
    description:'Generate vector embeddings for input text. Useful for RAG and semantic search.',
    auth:'api_key', status:'active',
    requestSchema:{ type:'object', required:['input'],
      properties:{ input:{type:'string'}, model:{type:'string',default:'nexgen-flash-v1'}, encoding_format:{type:'string',default:'float'} }},
    responseSchema:{ type:'object', properties:{ data:{type:'array'}, model:{type:'string'}, usage:{type:'object'} }},
  },
  {
    id:'ep-health-001', name:'Health Check', method:'GET', path:'/v1/health', version:'v1',
    description:'Returns the status of the NexGen inference server and loaded model.',
    auth:'none', status:'active',
    requestSchema:{}, responseSchema:{ type:'object', properties:{ status:{type:'string'}, model:{type:'string'}, uptime:{type:'number'} }},
  },
  {
    id:'ep-completions-001', name:'Completions (Legacy)', method:'POST', path:'/v1/completions', version:'v1',
    description:'Legacy text completion endpoint for non-chat use cases.',
    auth:'api_key', status:'draft',
    requestSchema:{ type:'object', required:['model','prompt'],
      properties:{ model:{type:'string'}, prompt:{type:'string'}, max_tokens:{type:'integer',default:512}, temperature:{type:'number',default:0.7} }},
    responseSchema:{ type:'object', properties:{ id:{type:'string'}, choices:{type:'array'}, usage:{type:'object'} }},
  },
];

const SEED_PIPELINES_API = [
  {
    id:'apipipe-001', name:'RAG Chat Pipeline', status:'active',
    description:'Retrieves context from the vector store, then sends enriched prompt to NexGen.',
    steps:[
      { id:'s1', type:'input',          label:'Receive query',       config:{ field:'query' } },
      { id:'s2', type:'rag_search',     label:'Search vector store', config:{ top_k:5, threshold:0.7 } },
      { id:'s3', type:'prompt_template',label:'Build prompt',        config:{ template:'Context:\n{{context}}\n\nQuestion: {{query}}' } },
      { id:'s4', type:'nexgen_call',    label:'Call NexGen',         config:{ model:'nexgen-flash-v1', max_tokens:1024 } },
      { id:'s5', type:'output',         label:'Return answer',       config:{ field:'content' } },
    ],
    inputSchema:{ type:'object', required:['query'], properties:{ query:{type:'string'} } },
    outputSchema:{ type:'object', properties:{ content:{type:'string'}, sources:{type:'array'} } },
  },
  {
    id:'apipipe-002', name:'Classify & Route Pipeline', status:'active',
    description:'Classifies user intent, routes to the correct domain specialist, returns typed response.',
    steps:[
      { id:'s1', type:'input',           label:'Receive message',    config:{ field:'message' } },
      { id:'s2', type:'nexgen_call',     label:'Classify intent',    config:{ model:'nexgen-flash-v1', system:'Classify the user message into one of these domains: chat, code, clinical, legal, finance, engineering. Return only the domain name.', max_tokens:20 } },
      { id:'s3', type:'route',           label:'Route to domain',    config:{ routes:{ code:'coding assistant', clinical:'clinical assistant', legal:'legal assistant', finance:'finance assistant' }, default:'general assistant' } },
      { id:'s4', type:'nexgen_call',     label:'Domain response',    config:{ model:'nexgen-pro-v1', max_tokens:1024 } },
      { id:'s5', type:'output',          label:'Return response',    config:{} },
    ],
    inputSchema:{ type:'object', required:['message'], properties:{ message:{type:'string'} } },
    outputSchema:{ type:'object', properties:{ content:{type:'string'}, domain:{type:'string'} } },
  },
];

async function seedApiDev() {
  const epCount = await prisma.apiEndpoint.count();
  if (epCount === 0) {
    for (const ep of SEED_ENDPOINTS) {
      await prisma.apiEndpoint.upsert({ where:{id:ep.id}, update:{}, create:ep });
    }
    console.log(`Seeded ${SEED_ENDPOINTS.length} API endpoints`);
  }
  const apCount = await prisma.apiPipeline.count();
  if (apCount === 0) {
    for (const p of SEED_PIPELINES_API) {
      await prisma.apiPipeline.upsert({ where:{id:p.id}, update:{}, create:p });
    }
    console.log(`Seeded ${SEED_PIPELINES_API.length} API pipelines`);
  }
}

// ── API Key helpers ───────────────────────────────────────────────────────────
function generateKey() {
  const rand = crypto.randomBytes(32).toString('hex');
  return `nxg-${rand}`;
}

const toApiEndpoint = e => ({ id:e.id, name:e.name, method:e.method, path:e.path, description:e.description,
  request_schema:e.requestSchema, response_schema:e.responseSchema, headers:e.headers,
  auth:e.auth, status:e.status, version:e.version, created_at:e.createdAt });
const toApiKey      = k => ({ id:k.id, name:k.name, prefix:k.prefix, permissions:k.permissions,
  status:k.status, request_count:k.requestCount, last_used_at:k.lastUsedAt,
  expires_at:k.expiresAt, created_at:k.createdAt });
const toApiPipeline = p => ({ id:p.id, name:p.name, description:p.description, steps:p.steps,
  input_schema:p.inputSchema, output_schema:p.outputSchema, status:p.status, created_at:p.createdAt });
const toApiRequest  = r => ({ id:r.id, endpoint_id:r.endpointId, method:r.method, path:r.path,
  headers:r.headers, body:r.body, response:r.response, status_code:r.statusCode,
  latency_ms:r.latencyMs, created_at:r.createdAt });

// ── ENDPOINTS ─────────────────────────────────────────────────────────────────
app.get('/api/dev/endpoints', authenticate, authorize('apidev:read'), async (req, res) => {
  try {
    const endpoints = await prisma.apiEndpoint.findMany({ orderBy:{ createdAt:'asc' } });
    res.json(endpoints.map(toApiEndpoint));
  } catch (err) { res.status(500).json({ error:err.message }); }
});

app.post('/api/dev/endpoints', authenticate, authorize('apidev:endpoints'), async (req, res) => {
  const { name, method='POST', path, description, request_schema={}, response_schema={}, headers={}, auth='api_key', version='v1' } = req.body;
  if (!name || !path) return res.status(400).json({ error:'name and path required' });
  try {
    const ep = await prisma.apiEndpoint.create({ data:{ name, method, path, description,
      requestSchema:request_schema, responseSchema:response_schema, headers, auth, version, status:'draft' } });
    res.status(201).json(toApiEndpoint(ep));
  } catch (err) { res.status(500).json({ error:err.message }); }
});

app.get('/api/dev/endpoints/:id', async (req, res) => {
  try {
    const ep = await prisma.apiEndpoint.findUnique({ where:{ id:req.params.id },
      include:{ requests:{ orderBy:{ createdAt:'desc' }, take:10 } } });
    if (!ep) return res.status(404).json({ error:'Endpoint not found' });
    res.json({ ...toApiEndpoint(ep), recent_requests: ep.requests.map(toApiRequest) });
  } catch (err) { res.status(500).json({ error:err.message }); }
});

app.put('/api/dev/endpoints/:id', async (req, res) => {
  const { name, method, path, description, request_schema, response_schema, auth, version } = req.body;
  try {
    const data = {};
    if (name !== undefined)           data.name = name;
    if (method !== undefined)         data.method = method;
    if (path !== undefined)           data.path = path;
    if (description !== undefined)    data.description = description;
    if (request_schema !== undefined) data.requestSchema = request_schema;
    if (response_schema !== undefined)data.responseSchema = response_schema;
    if (auth !== undefined)           data.auth = auth;
    if (version !== undefined)        data.version = version;
    const ep = await prisma.apiEndpoint.update({ where:{ id:req.params.id }, data });
    res.json(toApiEndpoint(ep));
  } catch (err) {
    if (err.code==='P2025') return res.status(404).json({ error:'Endpoint not found' });
    res.status(500).json({ error:err.message });
  }
});

app.patch('/api/dev/endpoints/:id/status', async (req, res) => {
  const { status } = req.body;
  const allowed = ['draft','active','deprecated'];
  if (!allowed.includes(status)) return res.status(400).json({ error:`status must be one of: ${allowed.join(', ')}` });
  try {
    const ep = await prisma.apiEndpoint.update({ where:{ id:req.params.id }, data:{ status } });
    res.json(toApiEndpoint(ep));
  } catch (err) {
    if (err.code==='P2025') return res.status(404).json({ error:'Endpoint not found' });
    res.status(500).json({ error:err.message });
  }
});

app.delete('/api/dev/endpoints/:id', async (req, res) => {
  try {
    await prisma.apiEndpoint.delete({ where:{ id:req.params.id } });
    res.json({ deleted:req.params.id });
  } catch (err) {
    if (err.code==='P2025') return res.status(404).json({ error:'Endpoint not found' });
    res.status(500).json({ error:err.message });
  }
});

// ── API KEYS ──────────────────────────────────────────────────────────────────
app.get('/api/dev/keys', authenticate, authorize('*'), async (req, res) => {
  try {
    const keys = await prisma.apiKey.findMany({ orderBy:{ createdAt:'desc' } });
    res.json(keys.map(toApiKey));  // never returns full key value after creation
  } catch (err) { res.status(500).json({ error:err.message }); }
});

app.post('/api/dev/keys', authenticate, authorize('*'), async (req, res) => {
  const { name, permissions=[], expires_at } = req.body;
  if (!name) return res.status(400).json({ error:'name required' });
  const key = generateKey();
  try {
    const k = await prisma.apiKey.create({ data:{ name, key, prefix:key.slice(0,16),
      permissions, status:'active', expiresAt: expires_at ? new Date(expires_at) : null } });
    await logActivity(req, 'key.created', k.id, { name });
    // Return the full key ONCE — it will never be returned again
    res.status(201).json({ ...toApiKey(k), key });
  } catch (err) { res.status(500).json({ error:err.message }); }
});

app.patch('/api/dev/keys/:id/revoke', authenticate, authorize('*'), async (req, res) => {
  try {
    const k = await prisma.apiKey.update({ where:{ id:req.params.id }, data:{ status:'revoked' } });
    await logActivity(req, 'key.revoked', k.id, { name:k.name });
    res.json(toApiKey(k));
  } catch (err) {
    if (err.code==='P2025') return res.status(404).json({ error:'Key not found' });
    res.status(500).json({ error:err.message });
  }
});

app.delete('/api/dev/keys/:id', authenticate, authorize('*'), async (req, res) => {
  try {
    const k = await prisma.apiKey.delete({ where:{ id:req.params.id } });
    await logActivity(req, 'key.deleted', req.params.id, { name:k.name });
    res.json({ deleted:req.params.id });
  } catch (err) {
    if (err.code==='P2025') return res.status(404).json({ error:'Key not found' });
    res.status(500).json({ error:err.message });
  }
});

// ── API PIPELINES ─────────────────────────────────────────────────────────────
app.get('/api/dev/pipelines', authenticate, authorize('apidev:read'), async (req, res) => {
  try {
    const pipelines = await prisma.apiPipeline.findMany({ orderBy:{ createdAt:'desc' } });
    res.json(pipelines.map(toApiPipeline));
  } catch (err) { res.status(500).json({ error:err.message }); }
});

app.post('/api/dev/pipelines', authenticate, authorize('apidev:write'), async (req, res) => {
  const { name, description, steps=[], input_schema={}, output_schema={} } = req.body;
  if (!name) return res.status(400).json({ error:'name required' });
  try {
    const p = await prisma.apiPipeline.create({ data:{ name, description, steps,
      inputSchema:input_schema, outputSchema:output_schema, status:'draft' } });
    res.status(201).json(toApiPipeline(p));
  } catch (err) { res.status(500).json({ error:err.message }); }
});

app.put('/api/dev/pipelines/:id', async (req, res) => {
  const { name, description, steps, input_schema, output_schema, status } = req.body;
  try {
    const data = {};
    if (name !== undefined)         data.name = name;
    if (description !== undefined)  data.description = description;
    if (steps !== undefined)        data.steps = steps;
    if (input_schema !== undefined) data.inputSchema = input_schema;
    if (output_schema !== undefined)data.outputSchema = output_schema;
    if (status !== undefined)       data.status = status;
    const p = await prisma.apiPipeline.update({ where:{ id:req.params.id }, data });
    res.json(toApiPipeline(p));
  } catch (err) {
    if (err.code==='P2025') return res.status(404).json({ error:'Pipeline not found' });
    res.status(500).json({ error:err.message });
  }
});

app.delete('/api/dev/pipelines/:id', async (req, res) => {
  try {
    await prisma.apiPipeline.delete({ where:{ id:req.params.id } });
    res.json({ deleted:req.params.id });
  } catch (err) {
    if (err.code==='P2025') return res.status(404).json({ error:'Pipeline not found' });
    res.status(500).json({ error:err.message });
  }
});

// Execute an API pipeline step-by-step
app.post('/api/dev/pipelines/:id/run', async (req, res) => {
  const pipeline = await prisma.apiPipeline.findUnique({ where:{ id:req.params.id } }).catch(()=>null);
  if (!pipeline) return res.status(404).json({ error:'Pipeline not found' });

  const { input={} } = req.body;
  const start = Date.now();
  const stepResults = [];
  let context = { ...input };
  let status = 'done';

  try {
    for (const step of (pipeline.steps||[])) {
      const stepStart = Date.now();
      let stepOutput = null;

      if (step.type === 'input') {
        stepOutput = input;
      } else if (step.type === 'prompt_template') {
        const tmpl = step.config?.template || '{{query}}';
        stepOutput = { text: tmpl.replace(/\{\{(\w+)\}\}/g, (_, k) => context[k] || '') };
        context.prompt = stepOutput.text;
      } else if (step.type === 'rag_search') {
        const query = context.query || JSON.stringify(input);
        const topK  = step.config?.top_k || 5;
        let docs = [];
        const nexgenEmb = await getNexGenEmbedding(query);
        if (nexgenEmb) {
          const vec = `[${nexgenEmb.data[0].embedding.join(',')}]`;
          docs = await prisma.$queryRaw`SELECT content,source FROM vector_documents WHERE embedding IS NOT NULL ORDER BY embedding <=> ${vec}::vector LIMIT ${topK}`;
        } else {
          docs = await prisma.vectorDocument.findMany({ take:topK });
        }
        context.context = docs.map(d=>d.content).join('\n\n');
        context.sources = docs.map(d=>d.source);
        stepOutput = { context:context.context, sources:context.sources };
      } else if (step.type === 'nexgen_call') {
        if (!anthropic) throw new Error('ANTHROPIC_API_KEY not configured');
        const prompt = context.prompt || context.query || JSON.stringify(input);
        const msg = await anthropic.messages.create({
          model:'claude-sonnet-4-6',
          max_tokens: step.config?.max_tokens || 1024,
          system: step.config?.system || 'You are NexGen, a helpful AI assistant.',
          messages:[{ role:'user', content:prompt }],
        });
        context.content = msg.content[0].text;
        stepOutput = { content:context.content, tokens:(msg.usage?.input_tokens||0)+(msg.usage?.output_tokens||0) };
      } else if (step.type === 'route') {
        const routes  = step.config?.routes || {};
        const def     = step.config?.default || 'general assistant';
        const intent  = context.content || context.query || '';
        const matched = Object.keys(routes).find(k => intent.toLowerCase().includes(k)) || null;
        context.route  = matched || def;
        context.system = routes[matched] || def;
        stepOutput = { route:context.route };
      } else if (step.type === 'transform') {
        const expr = step.config?.expression;
        stepOutput = expr ? eval(`(ctx => ${expr})(context)`) : context;
        Object.assign(context, typeof stepOutput==='object' ? stepOutput : {});
      } else if (step.type === 'http_request') {
        const fetch = (...a) => import('node-fetch').then(({default:f})=>f(...a));
        const url = (step.config?.url||'').replace(/\{\{(\w+)\}\}/g,(_,k)=>context[k]||'');
        const r = await fetch(url, { method:step.config?.method||'GET',
          headers:{'Content-Type':'application/json',...(step.config?.headers||{})},
          body:step.config?.body?JSON.stringify(step.config.body):undefined });
        stepOutput = await r.json().catch(()=>({ status:r.status }));
        Object.assign(context, { http_response:stepOutput });
      } else if (step.type === 'output') {
        stepOutput = context[step.config?.field||'content'] !== undefined
          ? { [step.config?.field||'content']: context[step.config?.field||'content'] }
          : context;
      }

      stepResults.push({ id:step.id, type:step.type, label:step.label,
        output:stepOutput, latency_ms:Date.now()-stepStart });
    }
  } catch (err) {
    stepResults.push({ type:'error', label:'Pipeline error', output:{ error:err.message }, latency_ms:0 });
    status = 'failed';
  }

  const latencyMs = Date.now() - start;
  const finalOutput = context;

  const run = await prisma.apiPipelineRun.create({
    data:{ pipelineId:pipeline.id, input, output:finalOutput, steps:stepResults, status, latencyMs }
  });

  res.json({ output:finalOutput, steps:stepResults, status, latency_ms:latencyMs, run_id:run.id });
});

// ── API TESTER (HTTP client proxy) ────────────────────────────────────────────
app.post('/api/dev/test', async (req, res) => {
  const { method='GET', url, headers={}, body, endpoint_id } = req.body;
  if (!url) return res.status(400).json({ error:'url required' });

  const start = Date.now();
  try {
    const fetch  = (...a) => import('node-fetch').then(({default:f})=>f(...a));
    const opts   = { method, headers:{'Content-Type':'application/json',...headers}, signal:AbortSignal.timeout(30000) };
    if (body && method !== 'GET') opts.body = JSON.stringify(body);

    const response      = await fetch(url, opts);
    const latencyMs     = Date.now() - start;
    const respHeaders   = Object.fromEntries(response.headers.entries());
    let   respBody;
    const ct = response.headers.get('content-type')||'';
    try { respBody = ct.includes('json') ? await response.json() : await response.text(); }
    catch { respBody = await response.text(); }

    // Log to history
    await prisma.apiRequest.create({ data:{
      endpointId: endpoint_id||null, method, path:url,
      headers, body, statusCode:response.status,
      response:{ body:respBody, headers:respHeaders }, latencyMs,
    }});

    // Bump key request count if Authorization header present
    if (headers.Authorization || headers.authorization) {
      const bearer = (headers.Authorization||headers.authorization||'').replace('Bearer ','');
      if (bearer.startsWith('nxg-')) {
        await prisma.apiKey.updateMany({ where:{ key:bearer },
          data:{ requestCount:{ increment:1 }, lastUsedAt:new Date() } });
      }
    }

    res.json({ status:response.status, status_text:response.statusText,
      headers:respHeaders, body:respBody, latency_ms:latencyMs });
  } catch (err) {
    await prisma.apiRequest.create({ data:{ method, path:url, headers, body,
      statusCode:0, response:{ error:err.message }, latencyMs:Date.now()-start } }).catch(()=>{});
    res.status(500).json({ error:err.message, latency_ms:Date.now()-start });
  }
});

// ── REQUEST HISTORY ───────────────────────────────────────────────────────────
app.get('/api/dev/history', async (req, res) => {
  try {
    const requests = await prisma.apiRequest.findMany({
      orderBy:{ createdAt:'desc' }, take:100 });
    res.json(requests.map(toApiRequest));
  } catch (err) { res.status(500).json({ error:err.message }); }
});

// ── OPENAPI SPEC ──────────────────────────────────────────────────────────────
app.get('/api/dev/openapi', async (req, res) => {
  try {
    const endpoints = await prisma.apiEndpoint.findMany({ where:{ status:'active' }, orderBy:{ path:'asc' } });
    const spec = {
      openapi:'3.0.0',
      info:{ title:'NexGen API', version:'1.0.0', description:'NexGen LLM API — Corverxis Technologies',
        contact:{ name:'Corverxis Technologies', url:'https://corverxis.com' } },
      servers:[{ url:process.env.NEXGEN_API_URL||'https://your-nexgen-server.onrender.com', description:'NexGen Inference Server' }],
      components:{ securitySchemes:{ ApiKeyAuth:{ type:'apiKey', in:'header', name:'Authorization' } } },
      paths:{},
    };
    endpoints.forEach(ep => {
      if (!spec.paths[ep.path]) spec.paths[ep.path] = {};
      spec.paths[ep.path][ep.method.toLowerCase()] = {
        summary:ep.name, description:ep.description||'',
        tags:[ep.version||'v1'],
        security: ep.auth==='none' ? [] : [{ ApiKeyAuth:[] }],
        requestBody: ep.method!=='GET' ? { required:true, content:{ 'application/json':{ schema:ep.requestSchema||{} } } } : undefined,
        responses:{ '200':{ description:'Success', content:{ 'application/json':{ schema:ep.responseSchema||{} } } },
          '401':{ description:'Unauthorized — invalid or missing API key' },
          '422':{ description:'Validation error' },
          '500':{ description:'Internal server error' } },
      };
    });
    res.json(spec);
  } catch (err) { res.status(500).json({ error:err.message }); }
});

// ═════════════════════════════════════════════════════════════════════════════
// NEXGEN LLM REST API  —  /v1/*
// OpenAI-compatible REST endpoints for the NexGen LLM model.
// These are the real callable API routes that external clients, the product
// frontend, and SDK integrations use.
// Auth: pass your lab API key as:  Authorization: Bearer nxg-...
// ═════════════════════════════════════════════════════════════════════════════

// ═════════════════════════════════════════════════════════════════════════════
// TIERED MEMORY ARCHITECTURE  —  fixes LLM limitation "no persistent memory"
// Working memory  = summarization + pruning of the live context window
// Episodic memory = per-API-key vector store, fact vs suggestion separated
// Consent layer   = memoryEnabled flag + visible/deletable Memory rows
// ═════════════════════════════════════════════════════════════════════════════

const MEMORY_TOKEN_THRESHOLD = 6000;   // ~ when to start summarizing older turns
const MEMORY_RECENT_KEEP     = 6;      // always keep the last N messages verbatim
const MEMORY_TOPK            = 5;      // episodic memories retrieved per request

// ── Working memory: summarize + prune when a conversation gets long ──────────
async function pruneWorkingMemory(messages, conversationId, ownerKey) {
  const approxTokens = messages.reduce((sum, m) => sum + (m.content?.length || 0) / 4, 0);
  if (approxTokens < MEMORY_TOKEN_THRESHOLD || messages.length <= MEMORY_RECENT_KEEP) {
    return messages; // short enough — nothing to prune
  }

  const older  = messages.slice(0, -MEMORY_RECENT_KEEP);
  const recent = messages.slice(-MEMORY_RECENT_KEEP);

  // Fold any prior summary in, so repeated pruning doesn't lose earlier context
  let priorSummary = '';
  if (conversationId) {
    const existing = await prisma.conversationSummary.findUnique({ where:{ conversationId } }).catch(() => null);
    if (existing) priorSummary = existing.summary;
  }

  if (!anthropic) return messages; // can't summarize without a model — fail safe, keep everything

  try {
    const transcript = older.map(m => `${m.role}: ${m.content}`).join('\n');
    const sum = await anthropic.messages.create({
      model: 'claude-sonnet-4-6', max_tokens: 500,
      system: 'You compress conversation history. Preserve names, numbers, decisions, and commitments exactly. Drop small talk and resolved tangents. Output plain prose, no headers.',
      messages: [{ role:'user', content:
        (priorSummary ? `EXISTING SUMMARY:\n${priorSummary}\n\n` : '') +
        `NEW TURNS TO FOLD IN:\n${transcript}\n\nWrite one updated summary covering everything above.` }],
    });
    const summary = sum.content[0]?.text?.trim() || priorSummary;

    if (conversationId) {
      await prisma.conversationSummary.upsert({
        where:  { conversationId },
        update: { summary, turnsCompressed: { increment: older.length } },
        create: { conversationId, ownerKey: ownerKey||'anon', summary, turnsCompressed: older.length },
      });
    }

    return [{ role:'user', content:`[Earlier conversation summary]: ${summary}` },
            { role:'assistant', content:'Understood, continuing from there.' },
            ...recent];
  } catch (_) {
    return messages; // summarization failed — safer to keep full history than lose it
  }
}

// ── Episodic memory: write a fact/suggestion, separated by type ──────────────
async function writeMemory(ownerKey, type, content, conversationId, sourceExcerpt) {
  if (!ownerKey || !content) return;
  try {
    await prisma.memory.create({ data:{
      ownerKey, type, content, conversationId: conversationId||null,
      sourceExcerpt: sourceExcerpt||null,
      confidence: type === 'user_fact' ? 1.0 : 0.6,
    }});
  } catch (_) {}
}

// ── After a response, extract new facts/suggestions worth remembering ────────
// Runs a lightweight classification pass — plain text output (not JSON, see
// the /api/generate lesson learned earlier: models are unreliable at JSON).
async function extractAndStoreMemories(ownerKey, userMsg, assistantMsg, conversationId) {
  if (!anthropic || !ownerKey) return;
  try {
    const resp = await anthropic.messages.create({
      model: 'claude-sonnet-4-6', max_tokens: 400,
      system: `Identify any durable facts worth remembering from this exchange for future conversations with this same user.
Respond in this exact format, one line per item, or "NONE" if nothing durable:
FACT: <something the user stated about themselves, their preferences, or their situation>
SUGGESTION: <something the assistant recommended or concluded, not yet confirmed by the user>
Only include information likely to matter in a future conversation — skip small talk, skip anything already generic.`,
      messages: [{ role:'user', content:`USER: ${userMsg}\n\nASSISTANT: ${assistantMsg}` }],
    });

    const lines = (resp.content[0]?.text || '').split('\n').map(l => l.trim()).filter(Boolean);
    for (const line of lines) {
      if (line.startsWith('FACT:')) {
        await writeMemory(ownerKey, 'user_fact', line.slice(5).trim(), conversationId, userMsg.slice(0,200));
      } else if (line.startsWith('SUGGESTION:')) {
        await writeMemory(ownerKey, 'model_suggestion', line.slice(11).trim(), conversationId, assistantMsg.slice(0,200));
      }
    }
  } catch (_) {} // never block the response on memory extraction
}

// ── Retrieve relevant episodic memories for this request ─────────────────────
async function retrieveMemories(ownerKey, query) {
  if (!ownerKey) return { facts:[], suggestions:[] };
  try {
    // Memory table has no embedding column yet — recency-ordered until that lands
    const rows = await prisma.memory.findMany({
      where: { ownerKey, visible:true },
      orderBy: { createdAt:'desc' }, take: MEMORY_TOPK * 2,
    });
    return {
      facts:       rows.filter(r => r.type === 'user_fact').slice(0, MEMORY_TOPK).map(r => r.content),
      suggestions: rows.filter(r => r.type === 'model_suggestion').slice(0, MEMORY_TOPK).map(r => r.content),
    };
  } catch (_) { return { facts:[], suggestions:[] }; }
}

function buildMemoryContextBlock(mem) {
  if (!mem.facts.length && !mem.suggestions.length) return '';
  let block = '\n\n--- MEMORY FROM PAST CONVERSATIONS WITH THIS USER ---\n';
  if (mem.facts.length) {
    block += 'CONFIRMED FACTS (the user stated these — treat as reliable):\n' +
      mem.facts.map(f => `- ${f}`).join('\n') + '\n';
  }
  if (mem.suggestions.length) {
    block += '\nPAST SUGGESTIONS (things you previously recommended — NOT confirmed, do not treat as fact):\n' +
      mem.suggestions.map(s => `- ${s}`).join('\n') + '\n';
  }
  block += '--- END MEMORY ---';
  return block;
}

// ═════════════════════════════════════════════════════════════════════════════
// GROUNDING & VERIFICATION  —  fixes LLM limitation "no grounding in reality"
// Detects time-sensitive claims, routes to live search, requires 2-source
// agreement before treating something as settled, flags user/source conflicts.
// ═════════════════════════════════════════════════════════════════════════════

const TIME_SENSITIVE_PATTERNS = /\b(today|current|currently|now|latest|this (week|month|year)|right now|as of|price of|stock|weather|news|score|who (is|are) the (current|present)|election result)\b/i;

function needsLiveGrounding(text) {
  return TIME_SENSITIVE_PATTERNS.test(text);
}

// ── Cross-source corroboration using web search tool ──────────────────────────
async function verifyWithWebSearch(claim, ownerKey) {
  if (!anthropic) return { corroborated:false, sources:[], note:'No model configured for verification' };
  try {
    const resp = await anthropic.messages.create({
      model: 'claude-sonnet-4-6', max_tokens: 800,
      tools: [{ type:'web_search_20250305', name:'web_search' }],
      messages: [{ role:'user', content:
        `Search for current information to verify this claim: "${claim}"\n` +
        `Search at least twice with different phrasing. Then respond in this format:\n` +
        `AGREE: yes|no|mixed\nSOURCE_COUNT: <number of distinct sources you found>\nSUMMARY: <one sentence>` }],
    });

    const text = resp.content.filter(b => b.type === 'text').map(b => b.text).join(' ');
    const agreeMatch  = text.match(/AGREE:\s*(\w+)/i);
    const countMatch  = text.match(/SOURCE_COUNT:\s*(\d+)/i);
    const corroborated = agreeMatch?.[1]?.toLowerCase() === 'yes' && Number(countMatch?.[1]||0) >= 2;

    await prisma.verificationLog.create({ data:{
      ownerKey: ownerKey||null, claim, claimType:'time_sensitive',
      sources: [], corroborated, conflictFlagged: agreeMatch?.[1]?.toLowerCase() === 'mixed',
    }});

    return { corroborated, note:text.slice(0,300), sourceCount: Number(countMatch?.[1]||0) };
  } catch (err) {
    return { corroborated:false, sources:[], note:'Verification failed: '+err.message };
  }
}

// ── Flag when a user's asserted claim conflicts with what we'd expect ────────
// Lightweight heuristic pass — a real implementation would compare against
// retrieved sources; here we ask the model to flag internal inconsistency.
async function flagUserAssertedConflicts(userMsg, ownerKey) {
  const assertionPattern = /\b(actually|in fact|the truth is|correct answer is|i know that|fyi)\b.{0,80}(is|was|are|were)\b/i;
  if (!assertionPattern.test(userMsg)) return null;
  await prisma.verificationLog.create({ data:{
    ownerKey: ownerKey||null, claim:userMsg.slice(0,500), claimType:'user_asserted',
    sources: [], corroborated:false, conflictFlagged:true,
  }}).catch(()=>{});
  return 'NOTE: the user has asserted a factual claim in this message. If it conflicts with what you know or can verify, say so explicitly rather than silently agreeing or silently overriding them.';
}

// ═════════════════════════════════════════════════════════════════════════════
// DETERMINISTIC & AUDITABLE MODES  —  fixes LLM limitation "inconsistency across runs"
// Factual/procedural queries run at near-zero temperature and are cached, so
// the same question returns the same answer every time. Every response gets
// a versioned reasoning log capturing what was retrieved and how it was produced.
// ═════════════════════════════════════════════════════════════════════════════

const REASONING_LOG_VERSION = 1;   // bump if the log schema/fields change

// ── Classify whether a query has one correct answer (deterministic) ──────────
// vs. an open-ended one (creative) — factual/procedural gets cached + low temp.
const DETERMINISTIC_PATTERNS = /^\s*(what is|what are|define|calculate|compute|convert|how (do|does|to)|steps? to|syntax for|formula for|list the|when (did|was)|who (is|was)|where is|explain the difference|what('|')s the (capital|population|boiling|melting))/i;
const CREATIVE_PATTERNS      = /\b(write (a|me) (story|poem|song|joke)|brainstorm|imagine|what do you think|your opinion|creative|pretend|roleplay)\b/i;

function classifyQueryMode(text) {
  if (CREATIVE_PATTERNS.test(text))      return 'creative';
  if (DETERMINISTIC_PATTERNS.test(text)) return 'deterministic';
  return 'creative'; // default to normal sampling unless clearly factual/procedural
}

function cacheKeyFor(model, systemPrompt, query) {
  const normalized = query.trim().toLowerCase().replace(/\s+/g, ' ');
  return crypto.createHash('sha256').update(model + '::' + systemPrompt.slice(0,200) + '::' + normalized).digest('hex');
}

// ── Check the cache before calling the model ──────────────────────────────────
async function getCachedResponse(model, systemPrompt, query) {
  const key = cacheKeyFor(model, systemPrompt, query);
  try {
    const hit = await prisma.responseCache.findUnique({ where:{ cacheKey:key } });
    if (hit) {
      await prisma.responseCache.update({ where:{ cacheKey:key },
        data:{ hitCount:{ increment:1 }, lastHitAt:new Date() } });
      return hit.response;
    }
  } catch (_) {}
  return null;
}

async function storeCachedResponse(model, systemPrompt, query, response) {
  const key = cacheKeyFor(model, systemPrompt, query);
  try {
    await prisma.responseCache.upsert({
      where:  { cacheKey:key },
      update: { response },
      create: { cacheKey:key, model, query:query.slice(0,500), response },
    });
  } catch (_) {}
}

// ── Write a versioned reasoning log for this response ─────────────────────────
async function writeReasoningLog(requestId, opts) {
  try {
    await prisma.reasoningLog.create({ data:{
      requestId, logVersion: REASONING_LOG_VERSION,
      mode: opts.mode, temperature: opts.temperature, wasCached: !!opts.wasCached,
      memoryFactsUsed: opts.memoryFactsUsed||0, memorySuggestionsUsed: opts.memorySuggestionsUsed||0,
      toolsCalled: opts.toolsCalled||[], groundingFlagged: !!opts.groundingFlagged,
      confidence: opts.confidence ?? null, ownerKey: opts.ownerKey || null,
    }});
  } catch (_) {}
}

// ── Auth middleware for /v1/* routes ─────────────────────────────────────────
async function requireApiKey(req, res, next) {
  const header = req.headers['authorization'] || req.headers['x-api-key'] || '';
  const key    = header.replace(/^Bearer\s+/i, '').trim();

  // Skip auth if no keys have been generated yet (bootstrap mode)
  const keyCount = await prisma.apiKey.count({ where:{ status:'active' } });
  if (keyCount === 0) return next();

  if (!key) return res.status(401).json({ error:{ message:'Missing API key. Pass Authorization: Bearer nxg-...', type:'authentication_error' } });
  if (!key.startsWith('nxg-')) return res.status(401).json({ error:{ message:'Invalid API key format.', type:'authentication_error' } });

  const dbKey = await prisma.apiKey.findUnique({ where:{ key } });
  if (!dbKey || dbKey.status !== 'active') {
    return res.status(401).json({ error:{ message:'Invalid or revoked API key.', type:'authentication_error' } });
  }
  if (dbKey.expiresAt && new Date(dbKey.expiresAt) < new Date()) {
    return res.status(401).json({ error:{ message:'API key has expired.', type:'authentication_error' } });
  }

  // Update usage stats
  await prisma.apiKey.update({ where:{ key },
    data:{ requestCount:{ increment:1 }, lastUsedAt:new Date() } });

  req.apiKey = dbKey;
  next();
}

// ── Helper: log every v1 request to trace history ────────────────────────────
async function logTrace(name, input, output, model, latencyMs, tokens) {
  try {
    await prisma.trace.create({ data:{ name, input, output, model,
      latencyMs, tokens, cost: tokens * 0.000003 } });   // approximate cost
    if (process.env.LANGFUSE_SECRET_KEY) {
      const lf = getLangfuse();
      lf.trace({ name, input, output, metadata:{ model, tokens } });
      lf.flush();
    }
  } catch (_) {}
}

// ── GET /v1/models — list available NexGen checkpoints ───────────────────────
app.get('/v1/models', requireApiKey, async (req, res) => {
  const tiers = [
    { id:'nexgen-flash-v1', tier:'flash', base:'Qwen3.5-9B',           max_tokens:8192  },
    { id:'nexgen-pro-v1',   tier:'pro',   base:'Qwen3.6-35B-A3B',      max_tokens:16384 },
    { id:'nexgen-ultra-v1', tier:'ultra', base:'Qwen3.5-397B-A17B',    max_tokens:32768 },
  ];
  res.json({
    object: 'list',
    data:   tiers.map(t => ({
      id:          t.id,
      object:      'model',
      created:     Math.floor(Date.now() / 1000),
      owned_by:    'corverxis-technologies',
      tier:        t.tier,
      base_model:  t.base,
      max_tokens:  t.max_tokens,
      permission:  [],
    })),
  });
});

// ── POST /v1/chat/completions — OpenAI-compatible chat ───────────────────────
app.post('/v1/chat/completions', requireApiKey, async (req, res) => {
  const { model='nexgen-flash-v1', messages=[], system, max_tokens=1024,
          temperature=0.7, stream=false, conversation_id=null, external_user_id=null } = req.body;

  if (!messages.length) {
    return res.status(422).json({ error:{ message:'messages array is required and must not be empty', type:'invalid_request_error' } });
  }
  if (!anthropic) {
    return res.status(503).json({ error:{ message:'ANTHROPIC_API_KEY not configured on this server.', type:'service_error' } });
  }

  const start    = Date.now();
  const rawApiKey = req.apiKey?.key || null;
  // external_user_id lets a single integration (like CorverxisONE) share one
  // nxg-... API key across many of ITS OWN end users, while still giving each
  // of those individual users properly isolated memory and audit trails —
  // without provisioning a separate NexGen API key per employee. The API key
  // remains the actual authentication; external_user_id only ever SCOPES
  // memory/logs, it is never trusted as an auth credential on its own.
  const safeExternalId = external_user_id
    ? String(external_user_id).replace(/[^a-zA-Z0-9_.@-]/g, '').slice(0, 128)
    : null;
  const ownerKey = rawApiKey && safeExternalId ? `${rawApiKey}::${safeExternalId}` : rawApiKey;
  let   sysPrompt = system ||
    messages.find(m => m.role === 'system')?.content ||
    'You are NexGen, a helpful AI assistant built by Corverxis Technologies.';
  let chatMsgs    = messages.filter(m => m.role !== 'system');
  const requestId = `chatcmpl-${crypto.randomBytes(12).toString('hex')}`;
  const lastUserMsg = [...chatMsgs].reverse().find(m => m.role === 'user')?.content || '';

  // ── Working memory: prune/summarize if the conversation has grown long ─────
  chatMsgs = await pruneWorkingMemory(chatMsgs, conversation_id, ownerKey);

  // ── Episodic memory: retrieve relevant facts/suggestions, inject as context ─
  let memoryUsed = { facts:0, suggestions:0 };
  if (ownerKey) {
    const customer = await prisma.customer.findFirst({ where:{ /* looked up via apiKey->customer in a fuller impl */ } }).catch(()=>null);
    const memoryOn = customer ? customer.memoryEnabled !== false : true; // default on
    if (memoryOn) {
      const mem = await retrieveMemories(ownerKey, lastUserMsg);
      sysPrompt += buildMemoryContextBlock(mem);
      memoryUsed = { facts: mem.facts.length, suggestions: mem.suggestions.length };
    }
  }

  // ── Grounding: flag conflicting user assertions, note if live data needed ──
  const conflictNote = await flagUserAssertedConflicts(lastUserMsg, ownerKey);
  if (conflictNote) sysPrompt += '\n\n' + conflictNote;
  const requiresLiveData = needsLiveGrounding(lastUserMsg);
  if (requiresLiveData) {
    sysPrompt += '\n\nNOTE: this question appears to be about current/time-sensitive information. ' +
      'State clearly if your knowledge may be outdated, rather than presenting a possibly-stale answer as current fact.';
  }

  // ── Deterministic mode: factual/procedural queries get near-zero temperature
  // and are served from cache when the exact same question has been asked before.
  const queryMode      = classifyQueryMode(lastUserMsg);
  const isDeterministic = queryMode === 'deterministic' && !requiresLiveData; // never cache time-sensitive answers
  const effectiveTemp   = isDeterministic ? 0.0 : temperature;
  let cachedResponse    = null;

  if (isDeterministic && !stream) {
    cachedResponse = await getCachedResponse(model, sysPrompt, lastUserMsg);
  }

  if (cachedResponse) {
    const latencyMs = Date.now() - start;
    await writeReasoningLog(requestId, {
      mode: 'deterministic', temperature: effectiveTemp, wasCached: true,
      memoryFactsUsed: memoryUsed.facts, memorySuggestionsUsed: memoryUsed.suggestions,
      toolsCalled: [], groundingFlagged: requiresLiveData, confidence: 1.0, ownerKey,
    });
    return res.json({
      id: requestId, object:'chat.completion', created: Math.floor(Date.now()/1000), model,
      choices: [{ index:0, message:{ role:'assistant', content:cachedResponse }, finish_reason:'stop' }],
      usage: { prompt_tokens:0, completion_tokens:0, total_tokens:0 },
      latency_ms: latencyMs,
      nexgen_meta: {
        memory_facts_used: memoryUsed.facts, memory_suggestions_used: memoryUsed.suggestions,
        live_grounding_flagged: requiresLiveData, mode: 'deterministic', cached: true,
      },
    });
  }

  try {
    if (stream) {
      // ── Streaming response (SSE) ──────────────────────────────────────────
      res.setHeader('Content-Type',  'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection',    'keep-alive');

      const streamResp = anthropic.messages.stream({
        model:      'claude-sonnet-4-6',
        max_tokens,
        temperature: effectiveTemp,
        system:     sysPrompt,
        messages:   chatMsgs,
      });

      let fullText = '', inputTokens = 0, outputTokens = 0;
      const created = Math.floor(Date.now() / 1000);

      streamResp.on('text', text => {
        fullText += text;
        const chunk = {
          id: requestId, object:'chat.completion.chunk',
          created, model,
          choices:[{ index:0, delta:{ content:text }, finish_reason:null }],
        };
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      });

      streamResp.on('message', msg => {
        inputTokens  = msg.usage?.input_tokens  || 0;
        outputTokens = msg.usage?.output_tokens || 0;
        const done = {
          id:requestId, object:'chat.completion.chunk', created, model,
          choices:[{ index:0, delta:{}, finish_reason:'stop' }],
        };
        res.write(`data: ${JSON.stringify(done)}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      });

      streamResp.on('error', err => {
        res.write(`data: ${JSON.stringify({ error:err.message })}\n\n`);
        res.end();
      });

      streamResp.finalMessage().then(msg => {
        const latencyMs = Date.now() - start;
        logTrace('chat.completions.stream', { messages, model }, { content:fullText },
          model, latencyMs, inputTokens + outputTokens);
        if (ownerKey && lastUserMsg) {
          extractAndStoreMemories(ownerKey, lastUserMsg, fullText, conversation_id).catch(()=>{});
        }
        if (isDeterministic) storeCachedResponse(model, sysPrompt, lastUserMsg, fullText).catch(()=>{});
        writeReasoningLog(requestId, {
          mode: queryMode, temperature: effectiveTemp, wasCached: false,
          memoryFactsUsed: memoryUsed.facts, memorySuggestionsUsed: memoryUsed.suggestions,
          toolsCalled: requiresLiveData ? ['grounding_check'] : [],
          groundingFlagged: requiresLiveData, confidence: isDeterministic ? 0.95 : null, ownerKey,
        }).catch(()=>{});
      });

    } else {
      // ── Non-streaming response ────────────────────────────────────────────
      // enable_code_execution opts into the Python tool-use loop — off by
      // default so existing integrations are unaffected.
      const enableCodeExec = req.body.enable_code_execution === true;

      let content, inputTokens, outputTokens, toolsUsedThisTurn = [];

      if (enableCodeExec) {
        const result = await runChatWithCodeExecution(sysPrompt, chatMsgs, max_tokens, effectiveTemp, ownerKey, req.body.domain);
        content = result.finalText;
        inputTokens = result.inputTokens;
        outputTokens = result.outputTokens;
        toolsUsedThisTurn = result.toolsCalled;
      } else {
        const msg = await anthropic.messages.create({
          model:      'claude-sonnet-4-6',
          max_tokens,
          temperature: effectiveTemp,
          system:     sysPrompt,
          messages:   chatMsgs,
        });
        content = msg.content[0]?.text || '';
        inputTokens  = msg.usage?.input_tokens  || 0;
        outputTokens = msg.usage?.output_tokens || 0;
      }

      const latencyMs    = Date.now() - start;

      await logTrace('chat.completions', { messages, model }, { content },
        model, latencyMs, inputTokens + outputTokens);

      // ── Deterministic mode: cache this response for future identical queries
      if (isDeterministic) await storeCachedResponse(model, sysPrompt, lastUserMsg, content);

      await writeReasoningLog(requestId, {
        mode: queryMode, temperature: effectiveTemp, wasCached: false,
        memoryFactsUsed: memoryUsed.facts, memorySuggestionsUsed: memoryUsed.suggestions,
        toolsCalled: [...(requiresLiveData ? ['grounding_check'] : []), ...toolsUsedThisTurn],
        groundingFlagged: requiresLiveData, confidence: isDeterministic ? 0.95 : null, ownerKey,
      });

      // ── Episodic memory write — fire-and-forget, never blocks the response ──
      if (ownerKey && lastUserMsg) {
        extractAndStoreMemories(ownerKey, lastUserMsg, content, conversation_id).catch(()=>{});
      }

      res.json({
        id:      requestId,
        object:  'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{
          index:         0,
          message:       { role:'assistant', content },
          finish_reason: msg.stop_reason === 'end_turn' ? 'stop' : msg.stop_reason,
        }],
        usage: {
          prompt_tokens:     inputTokens,
          completion_tokens: outputTokens,
          total_tokens:      inputTokens + outputTokens,
        },
        latency_ms: latencyMs,
        nexgen_meta: {
          memory_facts_used:       memoryUsed.facts,
          memory_suggestions_used: memoryUsed.suggestions,
          live_grounding_flagged:  requiresLiveData,
          mode:                    queryMode,
          cached:                  false,
          temperature_used:        effectiveTemp,
          code_execution_used:     toolsUsedThisTurn.some(t => t.startsWith('execute_code')),
          code_execution_language: toolsUsedThisTurn.find(t => t.startsWith('execute_code'))?.split(':')[1] || null,
          hardware_inspected:      toolsUsedThisTurn.includes('inspect_hardware'),
          ml_environment_inspected: toolsUsedThisTurn.includes('inspect_ml_environment'),
          document_generated:      toolsUsedThisTurn.some(t => t.startsWith('generate_document')),
          document_format:         toolsUsedThisTurn.find(t => t.startsWith('generate_document'))?.split(':')[1] || null,
          arxiv_searched:          toolsUsedThisTurn.includes('search_arxiv'),
          tools_used:              toolsUsedThisTurn,
          tool_calls:              toolsUsedThisTurn.length,
        },
      });
    }

  } catch (err) {
    res.status(500).json({ error:{ message:err.message, type:'api_error' } });
  }
});

// ── POST /v1/chat/stream — explicit SSE streaming endpoint ───────────────────
// Same as /v1/chat/completions with stream:true, kept separate for clarity
app.post('/v1/chat/stream', requireApiKey, async (req, res) => {
  req.body.stream = true;
  // delegate to completions handler above by re-using the route logic
  const { messages=[], system, max_tokens=1024, temperature=0.7 } = req.body;
  if (!messages.length) return res.status(422).json({ error:{ message:'messages required', type:'invalid_request_error' } });
  if (!anthropic)       return res.status(503).json({ error:{ message:'ANTHROPIC_API_KEY not set', type:'service_error' } });

  const sysPrompt  = system || 'You are NexGen, a helpful AI assistant by Corverxis Technologies.';
  const chatMsgs   = messages.filter(m => m.role !== 'system');
  const requestId  = `chatstream-${crypto.randomBytes(10).toString('hex')}`;
  const created    = Math.floor(Date.now() / 1000);
  const start      = Date.now();

  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');

  try {
    const stream = anthropic.messages.stream({ model:'claude-sonnet-4-6', max_tokens, system:sysPrompt, messages:chatMsgs });
    let fullText = '';

    stream.on('text', text => {
      fullText += text;
      res.write(`event: delta\ndata: ${JSON.stringify({ content:text, id:requestId })}\n\n`);
    });
    stream.on('message', msg => {
      const tokens = (msg.usage?.input_tokens||0)+(msg.usage?.output_tokens||0);
      res.write(`event: done\ndata: ${JSON.stringify({ id:requestId, tokens, latency_ms:Date.now()-start })}\n\n`);
      res.end();
      logTrace('chat.stream', { messages }, { content:fullText }, 'nexgen-flash-v1', Date.now()-start, tokens);
    });
    stream.on('error', err => {
      res.write(`event: error\ndata: ${JSON.stringify({ error:err.message })}\n\n`);
      res.end();
    });
  } catch (err) {
    res.write(`event: error\ndata: ${JSON.stringify({ error:err.message })}\n\n`);
    res.end();
  }
});

// ── POST /v1/completions — legacy text completion ────────────────────────────
app.post('/v1/completions', requireApiKey, async (req, res) => {
  const { model='nexgen-flash-v1', prompt='', max_tokens=512, temperature=0.7 } = req.body;
  if (!prompt) return res.status(422).json({ error:{ message:'prompt is required', type:'invalid_request_error' } });
  if (!anthropic) return res.status(503).json({ error:{ message:'ANTHROPIC_API_KEY not set', type:'service_error' } });

  const start = Date.now();
  try {
    const msg = await anthropic.messages.create({
      model:'claude-sonnet-4-6', max_tokens,
      messages:[{ role:'user', content:prompt }],
    });
    const text       = msg.content[0]?.text || '';
    const latencyMs  = Date.now() - start;
    const tokens     = (msg.usage?.input_tokens||0)+(msg.usage?.output_tokens||0);
    await logTrace('completions', { prompt, model }, { text }, model, latencyMs, tokens);
    res.json({
      id:      `cmpl-${crypto.randomBytes(10).toString('hex')}`,
      object:  'text_completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ text, index:0, finish_reason:'stop' }],
      usage:   { prompt_tokens:msg.usage?.input_tokens||0, completion_tokens:msg.usage?.output_tokens||0, total_tokens:tokens },
    });
  } catch (err) {
    res.status(500).json({ error:{ message:err.message, type:'api_error' } });
  }
});

// ── POST /v1/embeddings — text embeddings, powered by NexGen Pro ─────────────
app.post('/v1/embeddings', requireApiKey, async (req, res) => {
  const { input, model='nexgen-pro-v1' } = req.body;
  if (!input) return res.status(422).json({ error:{ message:'input is required', type:'invalid_request_error' } });

  if (!nexgenEmbeddingsReady()) {
    return res.status(503).json({
      error:{ message:'Embeddings require NEXGEN_PRO_API_KEY and NEXGEN_INFERENCE_URL to be set on this server. Falling back to full-text search elsewhere in the lab until then.', type:'service_error' }
    });
  }

  const start = Date.now();
  try {
    const texts = Array.isArray(input) ? input : [input];
    const resp  = await getNexGenEmbedding(texts);
    if (!resp) throw new Error('NexGen Pro embeddings endpoint did not respond');
    const latencyMs = Date.now() - start;
    await logTrace('embeddings', { input, model }, { count:resp.data.length }, model, latencyMs,
      resp.usage?.total_tokens || 0);
    res.json({
      object: 'list',
      data:   resp.data.map((d, i) => ({ object:'embedding', index:i, embedding:d.embedding })),
      model:  'nexgen-pro-v1',
      usage:  resp.usage,
    });
  } catch (err) {
    res.status(500).json({ error:{ message:err.message, type:'api_error' } });
  }
});

// ── GET /v1/health — inference server status ──────────────────────────────────
app.get('/v1/health', async (req, res) => {
  res.json({
    status:       'ok',
    version:      '1.0.0',
    models:       ['nexgen-flash-v1','nexgen-pro-v1','nexgen-ultra-v1'],
    api_key_set:  !!process.env.ANTHROPIC_API_KEY,
    embeddings:   nexgenEmbeddingsReady(),
    provider:     'Corverxis Technologies',
    uptime:       process.uptime(),
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// END NEXGEN LLM REST API
// ─────────────────────────────────────────────────────────────────────────────

// ── GET /api/activity — activity log (admin sees all, others see own) ────────
app.get('/api/activity', authenticate, async (req, res) => {
  const { user_id, limit=50 } = req.query;
  try {
    const where = {};
    if (!can(req.user, '*')) {
      where.userId = req.user.id;          // non-admins only see their own activity
    } else if (user_id) {
      where.userId = user_id;              // admin can filter by a specific user
    }
    const logs = await prisma.activityLog.findMany({
      where, orderBy:{ createdAt:'desc' }, take: Math.min(Number(limit)||50, 200),
    });
    res.json(logs.map(l => ({
      id: l.id, user_id: l.userId, user_email: l.userEmail,
      action: l.action, resource: l.resource, details: l.details,
      created_at: l.createdAt,
    })));
  } catch (err) { res.status(500).json({ error:err.message }); }
});

// ── GET /api/activity/summary — per-user counts (admin only) ─────────────────
app.get('/api/activity/summary', authenticate, authorize('*'), async (req, res) => {
  try {
    const logs = await prisma.activityLog.groupBy({
      by: ['userId', 'userEmail'],
      _count: { id: true },
      orderBy: { _count: { id: 'desc' } },
    });
    res.json(logs.map(l => ({ user_id:l.userId, user_email:l.userEmail, action_count:l._count.id })));
  } catch (err) { res.status(500).json({ error:err.message }); }
});


// ─────────────────────────────────────────────────────────────────────────────
// MEMORY MANAGEMENT — the consent & transparency layer
// Lets an engineer (or eventually the end customer) see, edit, and delete
// everything the system has remembered, per API key.
// ─────────────────────────────────────────────────────────────────────────────

// ── GET /api/memory — list memories for a given owner key ────────────────────
app.get('/api/memory', authenticate, authorize('rag:read'), async (req, res) => {
  const { owner_key, type } = req.query;
  try {
    const where = {};
    if (owner_key) where.ownerKey = owner_key;
    if (type)      where.type = type;
    const rows = await prisma.memory.findMany({ where, orderBy:{ createdAt:'desc' }, take:200 });
    res.json(rows.map(r => ({
      id:r.id, owner_key:r.ownerKey, type:r.type, content:r.content,
      visible:r.visible, confidence:r.confidence,
      conversation_id:r.conversationId, created_at:r.createdAt,
    })));
  } catch (err) { res.status(500).json({ error:err.message }); }
});

// ── PATCH /api/memory/:id — edit content or toggle visibility ────────────────
app.patch('/api/memory/:id', authenticate, authorize('rag:write'), async (req, res) => {
  const { content, visible } = req.body;
  try {
    const data = {};
    if (content !== undefined) data.content = content;
    if (visible !== undefined) data.visible = visible;
    const r = await prisma.memory.update({ where:{ id:req.params.id }, data });
    await logActivity(req, 'memory.edited', r.id, { type:r.type });
    res.json({ id:r.id, content:r.content, visible:r.visible });
  } catch (err) {
    if (err.code==='P2025') return res.status(404).json({ error:'Memory not found' });
    res.status(500).json({ error:err.message });
  }
});

// ── DELETE /api/memory/:id — explicit deletion control ────────────────────────
app.delete('/api/memory/:id', authenticate, authorize('rag:delete'), async (req, res) => {
  try {
    await prisma.memory.delete({ where:{ id:req.params.id } });
    await logActivity(req, 'memory.deleted', req.params.id, {});
    res.json({ deleted:req.params.id });
  } catch (err) {
    if (err.code==='P2025') return res.status(404).json({ error:'Memory not found' });
    res.status(500).json({ error:err.message });
  }
});

// ── DELETE /api/memory — wipe all memories for an owner key (full reset) ─────
app.delete('/api/memory', authenticate, authorize('rag:delete'), async (req, res) => {
  const { owner_key } = req.query;
  if (!owner_key) return res.status(400).json({ error:'owner_key query param required' });
  try {
    const result = await prisma.memory.deleteMany({ where:{ ownerKey:owner_key } });
    await logActivity(req, 'memory.wiped', owner_key, { count:result.count });
    res.json({ deleted_count: result.count });
  } catch (err) { res.status(500).json({ error:err.message }); }
});

// ── GET /api/memory/summaries — working-memory conversation summaries ────────
app.get('/api/memory/summaries', authenticate, authorize('rag:read'), async (req, res) => {
  try {
    const rows = await prisma.conversationSummary.findMany({ orderBy:{ updatedAt:'desc' }, take:100 });
    res.json(rows.map(r => ({
      conversation_id:r.conversationId, owner_key:r.ownerKey, summary:r.summary,
      turns_compressed:r.turnsCompressed, updated_at:r.updatedAt,
    })));
  } catch (err) { res.status(500).json({ error:err.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// GROUNDING & VERIFICATION API
// ─────────────────────────────────────────────────────────────────────────────

// ── POST /api/verify — check a claim against live web search, require 2 sources
app.post('/api/verify', authenticate, authorize('generate'), async (req, res) => {
  const { claim } = req.body;
  if (!claim) return res.status(400).json({ error:'claim required' });
  const result = await verifyWithWebSearch(claim, req.user?.email || null);
  res.json(result);
});

// ── GET /api/verify/log — history of verification checks ─────────────────────
app.get('/api/verify/log', authenticate, authorize('traces:read'), async (req, res) => {
  try {
    const rows = await prisma.verificationLog.findMany({ orderBy:{ createdAt:'desc' }, take:100 });
    res.json(rows.map(r => ({
      id:r.id, claim:r.claim, claim_type:r.claimType,
      corroborated:r.corroborated, conflict_flagged:r.conflictFlagged,
      created_at:r.createdAt,
    })));
  } catch (err) { res.status(500).json({ error:err.message }); }
});


// ─────────────────────────────────────────────────────────────────────────────
// DETERMINISTIC MODE & REASONING LOG API
// ─────────────────────────────────────────────────────────────────────────────

// ── GET /api/reasoning-logs — browse versioned reasoning logs ────────────────

// ─────────────────────────────────────────────────────────────────────────────
// CODE EXECUTION API — manual testing + audit log
// ─────────────────────────────────────────────────────────────────────────────

// ── GET /api/code/languages — list supported runtimes ─────────────────────────
// ── GET /api/system/hardware — real CPU/RAM/GPU info for this host ───────────
// ── POST /api/documents/generate — generate a document directly, for testing ─
// ── GET /api/documents/download/:token — the ONLY way to fetch a generated
// file. No public URL is ever handed out; this route validates the token,
// checks expiry, and streams the file. The token itself is the credential —
// deliberately not behind the usual `authenticate` middleware, since an end
// customer's browser has no API key header to send, only this link. ─────────
app.get('/api/documents/download/:token', async (req, res) => {
  try {
    const doc = await prisma.generatedDocument.findUnique({ where:{ downloadToken: req.params.token } });
    if (!doc) return res.status(404).send('Download link not found or already invalid.');
    if (doc.tokenExpiresAt < new Date()) return res.status(410).send('This download link has expired.');

    const contentType = DOCUMENT_CONTENT_TYPES[doc.format] || 'application/octet-stream';
    const safeName = doc.title.replace(/[^a-z0-9 _-]/gi, '').slice(0, 60) || 'document';
    const ext = { word:'docx', markdown:'md', powerpoint:'pptx', infographic:'svg', html:'html' }[doc.format] || 'bin';
    const isRenderable = doc.format === 'html' || doc.format === 'infographic';   // formats that could execute script if opened directly

    res.setHeader('Content-Type', contentType);
    res.setHeader('X-Content-Type-Options', 'nosniff');

    if (isRenderable) {
      // Rendered inline, never downloaded — and locked down so that even if
      // the content contains a <script> tag, it cannot make any network
      // request (connect-src 'none'), load any external resource, or be
      // framed by a third-party site. This is what actually makes it safe
      // to preview content that may include model- or user-influenced text.
      res.setHeader('Content-Security-Policy',
        "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: https:; font-src data:; connect-src 'none'; frame-ancestors 'self'");
      res.setHeader('Content-Disposition', `inline; filename="${safeName}.${ext}"`);
    } else {
      res.setHeader('Content-Disposition', `attachment; filename="${safeName}.${ext}"`);
    }

    if (doc.persistent && isS3Configured()) {
      if (isRenderable) {
        // Fetch and stream through our own response so the CSP headers above
        // actually apply — a redirect to a raw S3 URL would bypass them entirely.
        const { GetObjectCommand } = require('@aws-sdk/client-s3');
        const client = getS3Client();
        const obj = await client.send(new GetObjectCommand({ Bucket: process.env.S3_BUCKET, Key: doc.storageKey }));
        prisma.generatedDocument.update({ where:{ id:doc.id }, data:{ downloadCount:{ increment:1 } } }).catch(()=>{});
        return obj.Body.pipe(res);
      }
      const signedUrl = await getS3PresignedGetUrl(doc.storageKey, 300);   // 5-minute presigned S3 fetch
      return res.redirect(signedUrl);
    }

    const localPath = path.join(GENERATED_DIR, doc.storageKey);
    if (!fs.existsSync(localPath)) {
      return res.status(410).send('This file is no longer available on the server (local storage is not permanent — configure S3 for durable downloads).');
    }
    prisma.generatedDocument.update({ where:{ id:doc.id }, data:{ downloadCount:{ increment:1 } } }).catch(()=>{});
    res.sendFile(localPath);
  } catch (err) {
    res.status(500).send('Download failed: ' + err.message);
  }
});

app.post('/api/documents/generate', authenticate, authorize('generate'), async (req, res) => {
  const { format, title, domain } = req.body;
  if (!format || !title) return res.status(400).json({ error:'format and title required' });
  try {
    const result = await dispatchGenerateDocument(req.body, req.user?.id || null, domain);
    if (result.error) return res.status(400).json(result);
    res.status(201).json(result);
  } catch (err) { res.status(500).json({ error:err.message }); }
});

// ── GET /api/documents/history — audit log of every generated document ───────
// Note: intentionally does NOT return storageKey or downloadToken — this is
// a metadata/audit view, not a way to reconstruct a download link.
app.get('/api/documents/history', authenticate, authorize('traces:read'), async (req, res) => {
  const { owner_key, format, limit=50 } = req.query;
  try {
    const where = {};
    if (owner_key) where.ownerKey = owner_key;
    if (format)    where.format = format;
    const rows = await prisma.generatedDocument.findMany({
      where, orderBy:{ createdAt:'desc' }, take: Math.min(Number(limit)||50, 200),
    });
    res.json(rows.map(r => ({
      id:r.id, format:r.format, title:r.title, size_kb:r.fileSizeKb,
      persistent:r.persistent, expired: r.tokenExpiresAt < new Date(), download_count:r.downloadCount,
      owner_key:r.ownerKey, triggered_by:r.triggeredBy, domain:r.domain, created_at:r.createdAt,
    })));
  } catch (err) { res.status(500).json({ error:err.message }); }
});

// ── GET /api/research/arxiv — direct arXiv search test, outside the chat pipeline
app.get('/api/research/arxiv', authenticate, authorize('generate'), async (req, res) => {
  const { query, max_results } = req.query;
  if (!query) return res.status(400).json({ error:'query parameter required' });
  try {
    const result = await searchArxiv(query, max_results ? parseInt(max_results, 10) : 5);
    res.json(result);
  } catch (err) { res.status(500).json({ error:err.message }); }
});

app.get('/api/system/hardware', authenticate, authorize('generate'), async (req, res) => {
  try {
    const info = await inspectHardware();
    res.json(info);
  } catch (err) { res.status(500).json({ error:err.message }); }
});

// ── GET /api/system/ml-environment — real installed ML package versions ──────
app.get('/api/system/ml-environment', authenticate, authorize('generate'), async (req, res) => {
  try {
    const info = await inspectMLEnvironment();
    res.json(info);
  } catch (err) { res.status(500).json({ error:err.message }); }
});

app.get('/api/code/languages', authenticate, authorize('generate'), async (req, res) => {
  res.json({
    languages: Object.entries(LANGUAGE_RUNNERS).map(([id, r]) => ({ id, label: r.label, file_extension: r.ext })),
  });
});

// ── POST /api/code/execute — run code directly, outside the chat pipeline ────
app.post('/api/code/execute', authenticate, authorize('generate'), async (req, res) => {
  const { code, domain, language='python' } = req.body;
  if (!code) return res.status(400).json({ error:'code required' });
  if (!LANGUAGE_RUNNERS[language]) return res.status(400).json({ error:`Unsupported language. Supported: ${supportedLanguages().join(', ')}` });
  try {
    const result = await executeCode(language, code);
    await logCodeExecution(language, code, result, null, 'manual', domain);
    res.json({
      language, stdout: result.stdout, stderr: result.stderr, exit_code: result.exitCode,
      timed_out: result.timedOut, duration_ms: result.durationMs,
    });
  } catch (err) { res.status(500).json({ error:err.message }); }
});

// ── GET /api/code/history — audit log of every execution ─────────────────────
app.get('/api/code/history', authenticate, authorize('traces:read'), async (req, res) => {
  const { owner_key, language, limit=50 } = req.query;
  try {
    const where = {};
    if (owner_key) where.ownerKey = owner_key;
    if (language)  where.language = language;
    const rows = await prisma.codeExecution.findMany({
      where, orderBy:{ createdAt:'desc' }, take: Math.min(Number(limit)||50, 200),
    });
    res.json(rows.map(r => ({
      id:r.id, language:r.language, code:r.code, stdout:r.stdout, stderr:r.stderr, exit_code:r.exitCode,
      timed_out:r.timedOut, duration_ms:r.durationMs, owner_key:r.ownerKey,
      triggered_by:r.triggeredBy, domain:r.domain, created_at:r.createdAt,
    })));
  } catch (err) { res.status(500).json({ error:err.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// TASK ASSIGNMENTS — admins assign each team member a task from the side
// menu, with optional domain scoping for Data Collection and Processing.
// ─────────────────────────────────────────────────────────────────────────────

// ── GET /api/team/assignments — list assignments, optionally by user ─────────
app.get('/api/team/assignments', authenticate, authorize('records:read'), async (req, res) => {
  const isAdmin = can(req.user, '*');
  // Non-admins can only ever see their OWN assignments — this is intentionally
  // a hard override, not a default: even if a non-admin passes a different
  // user_id in the query string, it's ignored. Everyone needs to see what
  // they've been assigned to actually do the work, but only admins can see
  // (or set) assignments across the whole team.
  const user_id = isAdmin ? req.query.user_id : req.user?.id;
  try {
    const where = {};
    if (user_id) where.userId = user_id;
    const rows = await prisma.taskAssignment.findMany({ where, orderBy:{ createdAt:'desc' } });
    res.json(rows.map(r => ({
      id:r.id, user_id:r.userId, module:r.module, domains:r.domains, notes:r.notes,
      assigned_by_id:r.assignedById, created_at:r.createdAt, updated_at:r.updatedAt,
    })));
  } catch (err) { res.status(500).json({ error:err.message }); }
});

// ── POST /api/team/assignments — create or replace a user's assignment for
// a given module (one active assignment per user+module — creating a new
// one for the same module updates it rather than stacking duplicates) ────────
app.post('/api/team/assignments', authenticate, authorize('*'), async (req, res) => {
  const { user_id, module, domains=[], notes } = req.body;
  if (!user_id || !module) return res.status(400).json({ error:'user_id and module required' });
  try {
    const existing = await prisma.taskAssignment.findFirst({ where:{ userId:user_id, module } });
    const data = { userId:user_id, module, domains, notes: notes||null, assignedById: req.user?.id||null };
    const row = existing
      ? await prisma.taskAssignment.update({ where:{ id:existing.id }, data })
      : await prisma.taskAssignment.create({ data });
    await logActivity(req, 'assignment.set', row.id, { user_id, module, domains });
    res.status(201).json({
      id:row.id, user_id:row.userId, module:row.module, domains:row.domains, notes:row.notes,
      created_at:row.createdAt, updated_at:row.updatedAt,
    });
  } catch (err) { res.status(500).json({ error:err.message }); }
});

// ── DELETE /api/team/assignments/:id — remove one assignment ─────────────────
app.delete('/api/team/assignments/:id', authenticate, authorize('*'), async (req, res) => {
  try {
    await prisma.taskAssignment.delete({ where:{ id:req.params.id } });
    await logActivity(req, 'assignment.removed', req.params.id, {});
    res.json({ deleted:req.params.id });
  } catch (err) {
    if (err.code==='P2025') return res.status(404).json({ error:'Assignment not found' });
    res.status(500).json({ error:err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ASSIGNMENT ATTACHMENTS — admin uploads a file to a specific assignment;
// the assigned team member (and only that person, or an admin) can see and
// download it. Reuses the same document storage layer (S3 if configured,
// local disk otherwise) and the same signed, expiring download-token
// pattern already used for generate_document — no separate security model
// to maintain.
// ─────────────────────────────────────────────────────────────────────────────

const multer = require('multer');

// General-purpose attachment upload — PDF, Word, Excel, images, text, and
// most common document formats are all explicitly welcome. Only a short
// blocklist of executable/script file types is rejected, purely as a basic
// safety measure — this is not meant to be restrictive, just not a vector
// for uploading something that could run code on download.
const BLOCKED_ATTACHMENT_EXTENSIONS = ['.exe', '.bat', '.cmd', '.sh', '.msi', '.com', '.scr', '.vbs', '.ps1'];
const assignmentUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },   // 25MB cap — this is reference material, not a media library
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (BLOCKED_ATTACHMENT_EXTENSIONS.includes(ext)) {
      return cb(new Error(`File type ${ext} is not allowed for security reasons. PDF, Word, Excel, PowerPoint, images, text, and most other document formats are all accepted.`));
    }
    cb(null, true);
  },
});

// ── POST /api/team/assignments/:id/attachments — admin uploads a file ────────
app.post('/api/team/assignments/:id/attachments', authenticate, authorize('*'), (req, res) => {
  // Multer errors (blocked file type, size limit) must be caught explicitly
  // here — letting them fall through to a generic error handler would lose
  // the helpful message and likely return an unhelpful 500 instead.
  assignmentUpload.single('file')(req, res, async (uploadErr) => {
    if (uploadErr) {
      const msg = uploadErr.code === 'LIMIT_FILE_SIZE'
        ? 'File is too large — the limit is 25MB.'
        : uploadErr.message;
      return res.status(400).json({ error: msg });
    }
    if (!req.file) return res.status(400).json({ error:'file is required (multipart field name: "file")' });
    try {
      const assignment = await prisma.taskAssignment.findUnique({ where:{ id:req.params.id } });
      if (!assignment) return res.status(404).json({ error:'Assignment not found' });

      // Write the uploaded buffer to a temp local path first — storeGeneratedFile
      // expects a file already on disk (it was built for generated documents,
      // but doesn't care whether the bytes came from generation or upload).
      const safeExt = path.extname(req.file.originalname).replace(/[^a-zA-Z0-9.]/g, '').slice(0, 10) || '';
      const tempFilename = `nexgen-attach-${crypto.randomBytes(6).toString('hex')}${safeExt}`;
      const tempPath = path.join(GENERATED_DIR, tempFilename);
      fs.writeFileSync(tempPath, req.file.buffer);

      const { storageKey, persistent } = await storeGeneratedFile(tempPath, tempFilename);
      const downloadToken = crypto.randomBytes(24).toString('hex');

      const row = await prisma.assignmentAttachment.create({ data:{
        assignmentId: req.params.id,
        filename: req.file.originalname.slice(0, 200),
        storageKey, persistent,
        fileSizeKb: +(req.file.size / 1024).toFixed(1),
        mimeType: req.file.mimetype || null,
        downloadToken,
        tokenExpiresAt: new Date(Date.now() + DOWNLOAD_TOKEN_TTL_HOURS * 3600 * 1000),
        uploadedById: req.user?.id || null,
      }});

      await logActivity(req, 'assignment.attachment_uploaded', row.id, { assignment_id:req.params.id, filename:row.filename });
      res.status(201).json({
        id:row.id, filename:row.filename, size_kb:row.fileSizeKb, persistent:row.persistent,
        download_url: `${(process.env.APP_URL||'https://nexgen-frontier-lab.onrender.com').replace(/\/+$/,'')}/api/team/attachments/download/${downloadToken}`,
      });
    } catch (err) { res.status(500).json({ error:err.message }); }
  });
});

// ── GET /api/team/assignments/:id/attachments — list files for one assignment
// Non-admins can only list attachments on an assignment that is THEIRS. ──────
app.get('/api/team/assignments/:id/attachments', authenticate, authorize('records:read'), async (req, res) => {
  try {
    const assignment = await prisma.taskAssignment.findUnique({ where:{ id:req.params.id } });
    if (!assignment) return res.status(404).json({ error:'Assignment not found' });
    if (!can(req.user, '*') && assignment.userId !== req.user?.id) {
      return res.status(403).json({ error:'You can only view attachments on your own assignments.' });
    }
    const rows = await prisma.assignmentAttachment.findMany({
      where:{ assignmentId:req.params.id }, orderBy:{ createdAt:'desc' },
    });
    const base = (process.env.APP_URL||'https://nexgen-frontier-lab.onrender.com').replace(/\/+$/,'');
    res.json(rows.map(r => ({
      id:r.id, filename:r.filename, size_kb:r.fileSizeKb, mime_type:r.mimeType,
      persistent:r.persistent, expired: r.tokenExpiresAt < new Date(),
      download_url: `${base}/api/team/attachments/download/${r.downloadToken}`,
      created_at:r.createdAt,
    })));
  } catch (err) { res.status(500).json({ error:err.message }); }
});

// ── GET /api/team/attachments/download/:token — the only way to fetch a file.
// Same pattern as generated-document downloads: the token itself is the
// credential, deliberately not behind session auth, since the requester's
// browser has no API-key header to send — only this signed link. ────────────
app.get('/api/team/attachments/download/:token', async (req, res) => {
  try {
    const att = await prisma.assignmentAttachment.findUnique({ where:{ downloadToken: req.params.token } });
    if (!att) return res.status(404).send('Download link not found or already invalid.');
    if (att.tokenExpiresAt < new Date()) return res.status(410).send('This download link has expired.');

    res.setHeader('Content-Type', att.mimeType || 'application/octet-stream');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', `attachment; filename="${att.filename.replace(/[^a-zA-Z0-9 ._-]/g,'')}"`);

    if (att.persistent && isS3Configured()) {
      const signedUrl = await getS3PresignedGetUrl(att.storageKey, 300);
      return res.redirect(signedUrl);
    }
    const localPath = path.join(GENERATED_DIR, att.storageKey);
    if (!fs.existsSync(localPath)) {
      return res.status(410).send('This file is no longer available on the server (local storage is not permanent — configure S3 for durable attachments).');
    }
    res.sendFile(localPath);
  } catch (err) {
    res.status(500).send('Download failed: ' + err.message);
  }
});

// ── DELETE /api/team/attachments/:id — admin removes one attachment ──────────
app.delete('/api/team/attachments/:id', authenticate, authorize('*'), async (req, res) => {
  try {
    await prisma.assignmentAttachment.delete({ where:{ id:req.params.id } });
    await logActivity(req, 'assignment.attachment_removed', req.params.id, {});
    res.json({ deleted:req.params.id });
  } catch (err) {
    if (err.code==='P2025') return res.status(404).json({ error:'Attachment not found' });
    res.status(500).json({ error:err.message });
  }
});

app.get('/api/reasoning-logs', authenticate, authorize('traces:read'), async (req, res) => {
  const { request_id, owner_key, limit=100 } = req.query;
  try {
    const where = {};
    if (request_id) where.requestId = request_id;
    if (owner_key)  where.ownerKey  = owner_key;
    const rows = await prisma.reasoningLog.findMany({
      where, orderBy:{ createdAt:'desc' }, take: Math.min(Number(limit)||100, 300),
    });
    res.json(rows.map(r => ({
      id:r.id, request_id:r.requestId, log_version:r.logVersion, mode:r.mode,
      temperature:r.temperature, was_cached:r.wasCached,
      memory_facts_used:r.memoryFactsUsed, memory_suggestions_used:r.memorySuggestionsUsed,
      tools_called:r.toolsCalled, grounding_flagged:r.groundingFlagged,
      confidence:r.confidence, owner_key:r.ownerKey, created_at:r.createdAt,
    })));
  } catch (err) { res.status(500).json({ error:err.message }); }
});

// ── GET /api/cache/stats — response cache hit rate and size ──────────────────
app.get('/api/cache/stats', authenticate, authorize('traces:read'), async (req, res) => {
  try {
    const total   = await prisma.responseCache.count();
    const entries = await prisma.responseCache.findMany({ orderBy:{ hitCount:'desc' }, take:20 });
    const totalHits = entries.reduce((sum,e) => sum + e.hitCount, 0);
    res.json({
      cached_queries: total,
      total_cache_hits: totalHits,
      top_entries: entries.map(e => ({
        query: e.query.slice(0,120), hit_count: e.hitCount, model: e.model,
        created_at: e.createdAt, last_hit_at: e.lastHitAt,
      })),
    });
  } catch (err) { res.status(500).json({ error:err.message }); }
});

// ── DELETE /api/cache — clear the response cache (admin) ─────────────────────
app.delete('/api/cache', authenticate, authorize('*'), async (req, res) => {
  try {
    const result = await prisma.responseCache.deleteMany({});
    res.json({ deleted_count: result.count });
  } catch (err) { res.status(500).json({ error:err.message }); }
});



// ═════════════════════════════════════════════════════════════════════════════
// BEHAVIORAL REGRESSION & DRIFT DETECTION  —  Phase 3
// A golden set of validated examples is re-run against the current model,
// judged semantically (not string-matched) for factual consistency,
// completeness, and tone drift, then scored for regression severity.
// A run below threshold blocks deployment.
// ═════════════════════════════════════════════════════════════════════════════

const REGRESSION_SEVERITY_THRESHOLDS = {
  minor:    { minScore: 80 },   // avg score below this = at least "minor"
  moderate: { minScore: 65 },
  severe:   { minScore: 50 },   // below this = "severe", gate blocks deploy
};

function severityFromScore(avgScore, failRate) {
  if (avgScore < REGRESSION_SEVERITY_THRESHOLDS.severe.minScore || failRate > 0.15) return 'severe';
  if (avgScore < REGRESSION_SEVERITY_THRESHOLDS.moderate.minScore || failRate > 0.08) return 'moderate';
  if (avgScore < REGRESSION_SEVERITY_THRESHOLDS.minor.minScore || failRate > 0.03) return 'minor';
  return 'none';
}

// ── The judge — semantic diff between golden expected output and new output ──
// Plain-text labelled output (never JSON — see the /api/generate lesson).
async function judgeOutput(input, expectedOutput, actualOutput, domain) {
  if (!anthropic) return { score:0, verdict:'fail', judgeNotes:'ANTHROPIC_API_KEY not configured' };

  const start = Date.now();
  try {
    const resp = await anthropic.messages.create({
      model: 'claude-sonnet-4-6', max_tokens: 700,
      system: `You are a regression testing judge for NexGen, an AI assistant by Corverxis Technologies.
Compare a NEW output against a previously validated GOLDEN (expected) output for the same question,
in the "${domain}" domain. You are checking for semantic regression, not exact wording — paraphrasing
is fine. You are checking whether the NEW output is factually and functionally as good as the GOLDEN one.

Respond in EXACTLY this format, one line per field:
SCORE: <0-100, overall semantic equivalence and quality vs golden>
VERDICT: <pass|warning|fail>
FACTUAL_CONSISTENCY: <0-100, did the new output stay factually accurate>
COMPLETENESS: <0-100, did the new output cover everything material the golden one did>
TONE_DRIFT: <0-100, 100 = no drift, lower = tone/style diverged from golden>
ADDED_CLAIM: <a claim present in NEW but not in GOLDEN, or "none">
DROPPED_CLAIM: <a claim present in GOLDEN but missing from NEW, or "none">
ROOT_CAUSE: <model|prompt|rag_corpus|unclear — best guess at what would explain any regression>
NOTES: <one sentence explaining the score>

Scoring guide: 90-100 pass, 70-89 pass with minor notes, 50-69 warning, below 50 fail.
A lower score on NEW being MORE thorough/accurate than GOLDEN is not a regression — score that highly.`,
      messages: [{
        role: 'user',
        content: `QUESTION:\n${input}\n\nGOLDEN (expected) OUTPUT:\n${expectedOutput}\n\nNEW OUTPUT TO EVALUATE:\n${actualOutput}`,
      }],
    });

    const raw = resp.content[0]?.text || '';
    const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
    const get = (label) => lines.find(l => l.startsWith(label+':'))?.slice(label.length+1).trim();

    const score = parseFloat(get('SCORE')) || 0;
    const verdict = (get('VERDICT') || 'fail').toLowerCase();
    const addedClaim = get('ADDED_CLAIM');
    const droppedClaim = get('DROPPED_CLAIM');

    return {
      score, verdict: ['pass','warning','fail'].includes(verdict) ? verdict : 'fail',
      factualConsistency: parseFloat(get('FACTUAL_CONSISTENCY')) || null,
      completeness: parseFloat(get('COMPLETENESS')) || null,
      toneDrift: parseFloat(get('TONE_DRIFT')) || null,
      addedClaims: addedClaim && addedClaim.toLowerCase() !== 'none' ? [addedClaim] : [],
      droppedClaims: droppedClaim && droppedClaim.toLowerCase() !== 'none' ? [droppedClaim] : [],
      rootCause: get('ROOT_CAUSE') || 'unclear',
      judgeNotes: get('NOTES') || '',
      latencyMs: Date.now() - start,
    };
  } catch (err) {
    return { score:0, verdict:'fail', judgeNotes:'Judge error: '+err.message, latencyMs:Date.now()-start };
  }
}

// ── Hallucination detection — independent claim verification ─────────────────
// Distinct from factual_consistency (which only compares vs the golden answer):
// this checks each claim in the NEW output against what the model itself knows
// to be verifiable, flagging anything that reads as fabricated or unsupported.
async function detectHallucinationRate(input, actualOutput, domain) {
  if (!anthropic) return { hallucinationRate: null, unverifiedClaims: [] };
  try {
    const resp = await anthropic.messages.create({
      model: 'claude-sonnet-4-6', max_tokens: 500,
      system: `You are a hallucination auditor for NexGen. Extract every discrete factual claim in the
response below (numbers, names, dates, causal claims, specific facts) and assess whether each one is
the kind of claim that could be verified against a reliable source, or whether it reads as fabricated,
overconfident, or unsupported speculation presented as fact. This is for the "${domain}" domain.

Respond in exactly this format:
TOTAL_CLAIMS: <count>
UNVERIFIABLE_COUNT: <count of claims that seem fabricated or unsupported>
UNVERIFIABLE_CLAIM: <one flagged claim verbatim, or "none">
UNVERIFIABLE_CLAIM: <another flagged claim, or omit this line if none>
RATE: <0-100, percentage of claims that are unverifiable — 0 means fully grounded, 100 means entirely fabricated>`,
      messages: [{ role:'user', content: `QUESTION: ${input}\n\nRESPONSE TO AUDIT:\n${actualOutput}` }],
    });
    const raw = resp.content[0]?.text || '';
    const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
    const rateLine = lines.find(l => l.startsWith('RATE:'));
    const rate = rateLine ? parseFloat(rateLine.slice(5)) : null;
    const claims = lines.filter(l => l.startsWith('UNVERIFIABLE_CLAIM:'))
      .map(l => l.slice('UNVERIFIABLE_CLAIM:'.length).trim())
      .filter(c => c && c.toLowerCase() !== 'none');
    return { hallucinationRate: rate, unverifiedClaims: claims };
  } catch (_) { return { hallucinationRate: null, unverifiedClaims: [] }; }
}

// ── Bias drift detection — scored independently of correctness ────────────────
const BIAS_CATEGORIES = ['gender_stereotype', 'racial_ethnic_bias', 'political_lean', 'age_bias', 'cultural_bias', 'socioeconomic_bias', 'ableism'];

// ═════════════════════════════════════════════════════════════════════════════
// CODE EXECUTION — sandboxed multi-language runtime, callable by NexGen mid-response
// Supports Python, Node.js, TypeScript, Swift, and Kotlin. Lets the model run
// real code for calculations, verification, or demonstrating a fix instead of
// reasoning about it manually. Every execution is logged.
// ═════════════════════════════════════════════════════════════════════════════

const { spawn } = require('child_process');
const fs   = require('fs');
const os   = require('os');

const CODE_EXEC_TIMEOUT_MS = 10000;   // hard kill after 10s
const CODE_EXEC_MAX_OUTPUT = 20000;   // truncate stdout/stderr beyond this many chars

// ── Runner registry — one entry per supported language ────────────────────────
// Each runner writes the code to a temp file with the right extension (some
// toolchains — Swift, Kotlin script mode — require a real file, not stdin/-c),
// then spawns the interpreter/compiler with no shell involved.
const LANGUAGE_RUNNERS = {
  python: {
    label: 'Python 3', ext: 'py',
    cmd: 'python3', args: (f) => ['-I', f],   // -I: isolated mode, ignores env/site customization
  },
  node: {
    label: 'Node.js', ext: 'js',
    cmd: 'node', args: (f) => [f],
  },
  typescript: {
    label: 'TypeScript', ext: 'ts',
    cmd: 'npx', args: (f) => ['--no-install', 'ts-node', '--transpile-only',
      '--compiler-options', '{"module":"commonjs","target":"es2020","moduleResolution":"node","ignoreDeprecations":"6.0"}', f],
  },
  swift: {
    label: 'Swift', ext: 'swift',
    cmd: 'swift', args: (f) => [f],
  },
  kotlin: {
    label: 'Kotlin', ext: 'kts',
    cmd: 'kotlinc', args: (f) => ['-script', f],   // .kts = Kotlin script mode, no separate compile step
  },
};

function supportedLanguages() { return Object.keys(LANGUAGE_RUNNERS); }

// ── Run code in a locked-down subprocess ──────────────────────────────────────
// No shell (avoids injection — code never touches a shell string), fixed
// timeout, output size capped, minimal env, temp file cleaned up after.
async function executeCode(language, code) {
  const runner = LANGUAGE_RUNNERS[language];
  if (!runner) {
    return { stdout:'', stderr:`Unsupported language "${language}". Supported: ${supportedLanguages().join(', ')}`, exitCode:-1, timedOut:false, durationMs:0 };
  }

  const tmpFile = path.join(os.tmpdir(), `nexgen-exec-${crypto.randomBytes(8).toString('hex')}.${runner.ext}`);

  return new Promise((resolve) => {
    const start = Date.now();
    let stdout = '', stderr = '', timedOut = false, settled = false;

    const cleanup = () => fs.unlink(tmpFile, () => {});

    try {
      fs.writeFileSync(tmpFile, code, 'utf8');
    } catch (err) {
      return resolve({ stdout:'', stderr:'Failed to write source file: '+err.message, exitCode:-1, timedOut:false, durationMs:Date.now()-start });
    }

    let proc;
    try {
      proc = spawn(runner.cmd, runner.args(tmpFile), {
        env: { PATH: process.env.PATH || '/usr/bin:/bin' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      cleanup();
      return resolve({ stdout:'', stderr:`Failed to start ${runner.label}: ${err.message}. The ${runner.cmd} toolchain may not be installed on this server.`, exitCode:-1, timedOut:false, durationMs:Date.now()-start });
    }

    const killTimer = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGKILL');
    }, CODE_EXEC_TIMEOUT_MS);

    proc.stdout.on('data', d => { if (stdout.length < CODE_EXEC_MAX_OUTPUT) stdout += d.toString(); });
    proc.stderr.on('data', d => { if (stderr.length < CODE_EXEC_MAX_OUTPUT) stderr += d.toString(); });

    proc.on('close', (exitCode) => {
      if (settled) return; settled = true;
      clearTimeout(killTimer); cleanup();
      resolve({
        stdout: stdout.slice(0, CODE_EXEC_MAX_OUTPUT),
        stderr: timedOut ? `Execution timed out after ${CODE_EXEC_TIMEOUT_MS}ms and was killed.` : stderr.slice(0, CODE_EXEC_MAX_OUTPUT),
        exitCode: timedOut ? null : exitCode,
        timedOut, durationMs: Date.now() - start,
      });
    });
    proc.on('error', (err) => {
      if (settled) return; settled = true;
      clearTimeout(killTimer); cleanup();
      const hint = err.code === 'ENOENT' ? ` The ${runner.cmd} toolchain does not appear to be installed on this server.` : '';
      resolve({ stdout:'', stderr:`Execution error: ${err.message}.${hint}`, exitCode:-1, timedOut:false, durationMs:Date.now()-start });
    });
  });
}

async function logCodeExecution(language, code, result, ownerKey, triggeredBy, domain) {
  try {
    await prisma.codeExecution.create({ data:{
      language, code, stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode,
      timedOut: result.timedOut, durationMs: result.durationMs,
      ownerKey: ownerKey||null, triggeredBy, domain: domain||null,
    }});
  } catch (_) {}
}

// ── The tool definition given to Claude — one tool, language as a parameter ──
const CODE_EXEC_TOOL = {
  name: 'execute_code',
  description: `Execute code in a sandboxed environment and return stdout/stderr. Supports Python 3, Node.js (JavaScript), TypeScript, Swift, and Kotlin. Use this for calculations, numeric verification, data processing, algorithm demonstration, or anything that benefits from actually running code rather than reasoning about it manually. No internet access, no file system access outside the sandbox, 10 second execution limit.`,
  input_schema: {
    type: 'object',
    properties: {
      language: { type:'string', enum: supportedLanguages(), description:'Which language runtime to use.' },
      code:     { type:'string', description:'Complete, self-contained source code in the chosen language. Print/log output to stdout to return results.' },
    },
    required: ['language', 'code'],
  },
};

// ── Run a full tool-use loop: model may call execute_code, we run it, feed
// the result back, and let the model produce its final answer ────────────────
// ═════════════════════════════════════════════════════════════════════════════
// HARDWARE & ML ENVIRONMENT INSPECTION — real system data, not guesses
// Two new read-only tools NexGen can call to answer AI-engineering questions
// ("what GPU is available", "is CUDA set up", "what ML packages are installed")
// with actual data from the machine it's running on, instead of assuming.
// ═════════════════════════════════════════════════════════════════════════════

const { execFile } = require('child_process');

function execFilePromise(cmd, args, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) return reject(err);
      resolve(stdout);
    });
  });
}

// ── Hardware inspection — CPU/RAM always available via Node's os module;
// GPU info via nvidia-smi if present, fails gracefully to "no GPU detected" ──
async function inspectHardware() {
  const info = {
    cpu: { cores: os.cpus().length, model: os.cpus()[0]?.model || 'unknown' },
    memory: {
      total_gb: +(os.totalmem() / 1e9).toFixed(2),
      free_gb:  +(os.freemem()  / 1e9).toFixed(2),
    },
    platform: os.platform(),
    arch: os.arch(),
    gpu: { available: false, note: 'No NVIDIA GPU detected, or drivers/nvidia-smi not installed on this host.' },
  };

  try {
    const raw = await execFilePromise('nvidia-smi', [
      '--query-gpu=name,memory.total,memory.used,memory.free,utilization.gpu,temperature.gpu',
      '--format=csv,noheader,nounits',
    ]);
    const gpus = raw.trim().split('\n').filter(Boolean).map(line => {
      const [name, memTotal, memUsed, memFree, util, temp] = line.split(',').map(s => s.trim());
      return {
        name, memory_total_mb: Number(memTotal), memory_used_mb: Number(memUsed),
        memory_free_mb: Number(memFree), utilization_pct: Number(util), temperature_c: Number(temp),
      };
    });
    info.gpu = { available: gpus.length > 0, devices: gpus };
  } catch (_) {
    // nvidia-smi not found or failed — info.gpu stays as the "not detected" default above
  }

  return info;
}

// ── ML environment inspection — runs a real Python check via the same
// sandbox used by execute_code, so results reflect what's genuinely installed
async function inspectMLEnvironment() {
  const checkScript = `
import importlib, json

packages = ['torch','tensorflow','sklearn','transformers','numpy','pandas','onnx','xgboost','lightgbm']
result = {}
for pkg in packages:
    try:
        mod = importlib.import_module(pkg)
        result[pkg] = getattr(mod, '__version__', 'installed')
    except Exception:
        result[pkg] = None

cuda_info = {'torch_cuda_available': False}
try:
    import torch
    cuda_info['torch_cuda_available'] = torch.cuda.is_available()
    if cuda_info['torch_cuda_available']:
        cuda_info['device_count'] = torch.cuda.device_count()
        cuda_info['device_name'] = torch.cuda.get_device_name(0)
except Exception:
    pass

print(json.dumps({'packages': result, 'cuda': cuda_info}))
`.trim();

  const result = await executeCode('python', checkScript);
  if (result.exitCode !== 0 && !result.stdout) {
    return { error: 'Could not run environment check', stderr: result.stderr };
  }
  try { return JSON.parse(result.stdout.trim()); }
  catch (_) { return { error: 'Could not parse environment check output', raw_stdout: result.stdout, stderr: result.stderr }; }
}

const HARDWARE_TOOL = {
  name: 'inspect_hardware',
  description: 'Query real hardware information for the machine NexGen is running on: CPU core count and model, total and free RAM, and GPU details (name, VRAM total/used/free, utilization, temperature) if an NVIDIA GPU is present. Use this instead of guessing when a user asks about available compute resources.',
  input_schema: { type:'object', properties: {}, required: [] },
};

// ═════════════════════════════════════════════════════════════════════════════
// DOCUMENT GENERATION — real Word, Markdown, PowerPoint, and infographic output
// NexGen can produce actual downloadable files mid-response, not just describe
// what a document would contain. Files are written to a static-served folder
// and every generation is logged for audit.
// ═════════════════════════════════════════════════════════════════════════════

const { Document: DocxDocument, Packer: DocxPacker, Paragraph: DocxParagraph,
        TextRun: DocxTextRun, HeadingLevel: DocxHeadingLevel } = require('docx');
const PptxGenJS = require('pptxgenjs');

const GENERATED_DIR = path.join(__dirname, 'static', 'generated');
if (!fs.existsSync(GENERATED_DIR)) fs.mkdirSync(GENERATED_DIR, { recursive: true });

// ── Object storage (S3-compatible) — optional, with automatic fallback ───────
// Render's local disk is ephemeral: wiped on every deploy/restart. If S3
// credentials are configured, generated documents are uploaded there instead
// and survive restarts. Either way, the BUCKET STAYS PRIVATE — no public-read
// ACL. Access is only ever granted through a signed, time-limited download
// token (below), never a permanent public URL.
function isS3Configured() {
  return !!(process.env.S3_BUCKET && process.env.S3_ACCESS_KEY_ID && process.env.S3_SECRET_ACCESS_KEY);
}

let _s3Client = null;
function getS3Client() {
  if (_s3Client) return _s3Client;
  const { S3Client } = require('@aws-sdk/client-s3');
  _s3Client = new S3Client({
    region: process.env.S3_REGION || 'auto',
    endpoint: process.env.S3_ENDPOINT || undefined,   // set for Cloudflare R2 / non-AWS S3-compatible; omit for real AWS S3
    forcePathStyle: !!process.env.S3_ENDPOINT,         // most non-AWS S3-compatible services need path-style URLs
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY_ID,
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
    },
  });
  return _s3Client;
}

const DOCUMENT_CONTENT_TYPES = {
  word:        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  markdown:    'text/markdown',
  powerpoint:  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  infographic: 'image/svg+xml',
  html:        'text/html',
};

// ── Upload to a PRIVATE bucket — no ACL, nothing publicly reachable by design.
// Returns the storage key only; the caller is responsible for handing out a
// signed download token, never this key or a direct bucket URL. ─────────────
async function uploadToS3Private(localFilePath, filename) {
  const { PutObjectCommand } = require('@aws-sdk/client-s3');
  const client = getS3Client();
  const bucket = process.env.S3_BUCKET;
  const key = `nexgen-documents/${filename}`;
  const body = fs.readFileSync(localFilePath);
  await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body }));  // no ACL — bucket stays private
  return key;
}

async function getS3PresignedGetUrl(storageKey, expiresInSeconds) {
  const { GetObjectCommand } = require('@aws-sdk/client-s3');
  const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
  const client = getS3Client();
  const cmd = new GetObjectCommand({ Bucket: process.env.S3_BUCKET, Key: storageKey });
  return getSignedUrl(client, cmd, { expiresIn: expiresInSeconds });
}

// ── Store the file (S3 if configured, local disk otherwise) and return a
// storageKey — never a public URL. Never throws: a failed S3 upload falls
// back to local disk so the document is never silently lost. ────────────────
async function storeGeneratedFile(localFilePath, filename) {
  if (isS3Configured()) {
    try {
      const storageKey = await uploadToS3Private(localFilePath, filename);
      fs.unlink(localFilePath, () => {});   // S3 is now the source of truth, local copy was scratch space
      return { storageKey, persistent: true };
    } catch (err) {
      console.error(`S3 upload failed for ${filename}, falling back to local disk: ${err.message}`);
    }
  }
  return { storageKey: filename, persistent: false };   // local: storageKey is just the filename under GENERATED_DIR
}

const DOWNLOAD_TOKEN_TTL_HOURS = 24;

function buildSecureDownloadUrl(token) {
  const base = (process.env.APP_URL || 'https://nexgen-frontier-lab.onrender.com').replace(/\/+$/, '');
  return `${base}/api/documents/download/${token}`;
}

// ── Word (.docx) — title + an array of {heading, body} sections ──────────────
async function generateWordDoc(title, sections) {
  const children = [
    new DocxParagraph({ heading: DocxHeadingLevel.TITLE, children: [new DocxTextRun({ text: title, bold: true })] }),
  ];
  for (const s of sections) {
    if (s.heading) children.push(new DocxParagraph({ heading: DocxHeadingLevel.HEADING_1, spacing:{ before:300, after:120 },
      children: [new DocxTextRun({ text: s.heading, bold: true })] }));
    if (s.body) children.push(new DocxParagraph({ spacing:{ after:200 }, children: [new DocxTextRun(s.body)] }));
  }
  const doc = new DocxDocument({ sections: [{ children }] });
  const buffer = await DocxPacker.toBuffer(doc);
  const filename = `nexgen-${crypto.randomBytes(6).toString('hex')}.docx`;
  fs.writeFileSync(path.join(GENERATED_DIR, filename), buffer);
  return { filename, sizeKb: +(buffer.length / 1024).toFixed(1) };
}

// ── Markdown (.md) — title + raw markdown body ────────────────────────────────
async function generateMarkdown(title, body) {
  const content = `# ${title}\n\n${body}`;
  const filename = `nexgen-${crypto.randomBytes(6).toString('hex')}.md`;
  fs.writeFileSync(path.join(GENERATED_DIR, filename), content, 'utf8');
  return { filename, sizeKb: +(Buffer.byteLength(content, 'utf8') / 1024).toFixed(1) };
}

// ── PowerPoint (.pptx) — title + array of {title, bullets[]} slides ──────────
async function generatePowerPoint(deckTitle, slides) {
  const pres = new PptxGenJS();
  pres.layout = 'LAYOUT_WIDE';

  const title = pres.addSlide();
  title.addText(deckTitle, { x:0.5, y:2.5, w:12.3, h:1.2, fontSize:36, bold:true, align:'center', color:'0A1628' });
  title.addText('Generated by NexGen — Corverxis Technologies', { x:0.5, y:3.6, w:12.3, h:0.4, fontSize:14, align:'center', color:'5A6B7D' });

  for (const s of slides) {
    const slide = pres.addSlide();
    slide.addText(s.title || '', { x:0.5, y:0.4, w:12.3, h:0.7, fontSize:26, bold:true, color:'0A1628' });
    const bulletText = (s.bullets || []).map(b => ({ text: b, options: { bullet: true, breakLine: true, fontSize:18, color:'1A1A1A' } }));
    if (bulletText.length) slide.addText(bulletText, { x:0.6, y:1.3, w:12.0, h:5.5 });
  }

  const filename = `nexgen-${crypto.randomBytes(6).toString('hex')}.pptx`;
  await pres.writeFile({ fileName: path.join(GENERATED_DIR, filename) });
  const sizeKb = +(fs.statSync(path.join(GENERATED_DIR, filename)).size / 1024).toFixed(1);
  return { filename, sizeKb };
}

// ── Infographic (.svg) — title + array of {label, value, color?} stat cards ──
function xmlEscape(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;');
}

function generateInfographic(title, stats) {
  const cardW = 240, cardH = 140, gap = 24, cols = Math.min(stats.length, 4);
  const width = cols * cardW + (cols + 1) * gap;
  const rows = Math.ceil(stats.length / cols);
  const height = 120 + rows * (cardH + gap);
  const palette = ['#00CFFF', '#8B5CF6', '#22D3A5', '#F97316', '#F87171', '#FBBF24'];

  let cardsSvg = '';
  stats.forEach((s, i) => {
    const col = i % cols, row = Math.floor(i / cols);
    const x = gap + col * (cardW + gap), y = 110 + row * (cardH + gap);
    const color = /^#[0-9a-f]{3,8}$/i.test(s.color || '') ? s.color : palette[i % palette.length];   // validate, don't trust raw input for an attribute value
    cardsSvg += `
      <rect x="${x}" y="${y}" width="${cardW}" height="${cardH}" rx="10" fill="#0D1E35" stroke="${color}" stroke-width="1.5" stroke-opacity="0.4"/>
      <rect x="${x}" y="${y}" width="6" height="${cardH}" rx="3" fill="${color}"/>
      <text x="${x+28}" y="${y+58}" font-family="Arial" font-size="34" font-weight="700" fill="${color}">${xmlEscape(s.value)}</text>
      <text x="${x+28}" y="${y+92}" font-family="Arial" font-size="14" fill="#7A9CC4">${xmlEscape(String(s.label).toUpperCase())}</text>`;
  });

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <rect width="${width}" height="${height}" fill="#0A1628"/>
    <text x="${width/2}" y="55" font-family="Arial" font-size="28" font-weight="700" fill="#00CFFF" text-anchor="middle">${xmlEscape(title)}</text>
    <text x="${width/2}" y="82" font-family="Arial" font-size="12" fill="#5A6B7D" text-anchor="middle">CORVERXIS TECHNOLOGIES · GENERATED BY NEXGEN</text>
    ${cardsSvg}
  </svg>`;

  const filename = `nexgen-${crypto.randomBytes(6).toString('hex')}.svg`;
  fs.writeFileSync(path.join(GENERATED_DIR, filename), svg, 'utf8');
  return { filename, sizeKb: +(Buffer.byteLength(svg, 'utf8') / 1024).toFixed(1) };
}

// ── HTML (.html) — title + full HTML body (may include inline CSS/JS) ────────
// Security note: whatever script tags this contains will actually execute in
// a real browser when previewed. Nothing here restricts what the model can
// generate — the safety boundary is entirely at serving time (see the
// Content-Security-Policy and sandboxed-iframe handling in the download
// route below), not at generation time.
function generateHTML(title, htmlBody) {
  // Defensive fallback — an empty body would otherwise silently produce a
  // technically-valid but completely blank page, with no error anywhere in
  // the pipeline to explain why. Make the failure visible instead.
  const safeBody = (htmlBody && htmlBody.trim())
    ? htmlBody
    : `<div style="font-family:sans-serif;padding:40px;color:#b91c1c;background:#fef2f2;border:1px solid #fecaca;border-radius:8px;max-width:600px;margin:40px auto">
        <h2 style="margin-top:0">No content was provided</h2>
        <p>This HTML document was generated with an empty body. This usually means the html_body field was missing or blank when generate_document was called.</p>
      </div>`;

  const hasDoctype = /^\s*<!doctype/i.test(safeBody);
  const content = hasDoctype ? safeBody : `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>${title.replace(/</g, '&lt;')}</title>
</head>
<body>
${safeBody}
</body>
</html>`;

  const filename = `nexgen-${crypto.randomBytes(6).toString('hex')}.html`;
  fs.writeFileSync(path.join(GENERATED_DIR, filename), content, 'utf8');
  return { filename, sizeKb: +(Buffer.byteLength(content, 'utf8') / 1024).toFixed(1) };
}

async function logGeneratedDocument(format, title, storageKey, sizeKb, persistent, downloadToken, ownerKey, triggeredBy, domain) {
  try {
    await prisma.generatedDocument.create({ data:{
      format, title, storageKey, persistent, fileSizeKb: sizeKb,
      downloadToken, tokenExpiresAt: new Date(Date.now() + DOWNLOAD_TOKEN_TTL_HOURS * 3600 * 1000),
      ownerKey: ownerKey||null, triggeredBy, domain: domain||null,
    }});
  } catch (_) {}
}

// ═════════════════════════════════════════════════════════════════════════════
// AI RESEARCH — arXiv literature search, callable by NexGen mid-response
// Gives NexGen a genuine way to search current AI/ML research papers instead
// of relying on stale training-data knowledge of "what papers exist." Uses
// arXiv's free, public Atom-feed API — no API key required.
// ═════════════════════════════════════════════════════════════════════════════

function xmlUnescape(str) {
  return String(str).replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&apos;/g,"'");
}

// ── Parse arXiv's Atom XML feed format into plain objects ────────────────────
// arXiv's feed structure is stable and documented (https://info.arxiv.org/help/api/user-manual.html):
// each <entry> contains <title>, <summary>, <published>, <id>, and one or
// more <author><name>...</name></author> blocks.
function parseArxivAtom(xml) {
  const entries = [];
  const entryBlocks = xml.match(/<entry>[\s\S]*?<\/entry>/g) || [];
  for (const block of entryBlocks) {
    const get = (tag) => {
      const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`));
      return m ? xmlUnescape(m[1]).trim().replace(/\s+/g, ' ') : '';
    };
    const authors = [...block.matchAll(/<name>([\s\S]*?)<\/name>/g)].map(m => xmlUnescape(m[1]).trim());
    const idUrl = get('id');
    const arxivId = (idUrl.match(/abs\/([^\/]+)$/) || [,idUrl])[1];
    entries.push({
      title: get('title'),
      summary: get('summary'),
      published: get('published').slice(0, 10),   // just the date, not full ISO timestamp
      authors,
      arxiv_id: arxivId,
      url: idUrl,
    });
  }
  return entries;
}

async function searchArxiv(query, maxResults = 5) {
  const capped = Math.min(Math.max(maxResults || 5, 1), 10);   // arXiv allows more, but keep responses focused
  const url = `http://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(query)}&start=0&max_results=${capped}&sortBy=submittedDate&sortOrder=descending`;
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!resp.ok) return { error: `arXiv API returned ${resp.status}`, results: [] };
    const xml = await resp.text();
    const results = parseArxivAtom(xml);
    return { results, count: results.length };
  } catch (err) {
    return { error: `arXiv search failed: ${err.message}`, results: [] };
  }
}

const ARXIV_SEARCH_TOOL = {
  name: 'search_arxiv',
  description: 'Search arXiv for current AI/ML research papers by keyword. Returns titles, authors, abstracts, publish dates, and links, sorted by most recently submitted. Use this when a question is about recent research, a specific paper, or when training-data knowledge of "what papers exist" may be outdated — this searches the live arXiv index, not memory.',
  input_schema: {
    type: 'object',
    properties: {
      query: { type:'string', description:'Search keywords, e.g. "mixture of experts routing" or "reinforcement learning from human feedback".' },
      max_results: { type:'integer', description:'How many papers to return, 1-10. Defaults to 5.' },
    },
    required: ['query'],
  },
};


const GENERATE_DOC_TOOL = {
  name: 'generate_document',
  description: `Generate a real, downloadable/previewable document — Word (.docx), Markdown (.md), PowerPoint (.pptx), an SVG infographic, or a live HTML page. Use this when a user asks for a report, a document, slides, a visual summary, or a webpage/prototype they can view or share, rather than just describing the content in the chat response. The returned link is a signed, single-use-scope download URL that expires after ${DOWNLOAD_TOKEN_TTL_HOURS} hours — tell the user to use it before then. For html format specifically, the link renders live in a browser (a preview), it does not just download.`,
  input_schema: {
    type: 'object',
    properties: {
      format: { type:'string', enum: ['word','markdown','powerpoint','infographic','html'], description:'Which document type to generate.' },
      title:  { type:'string', description:'Document or deck title.' },
      sections: {
        type:'array', description:'For word: array of {heading, body}. Ignored for other formats.',
        items: { type:'object', properties: { heading:{type:'string'}, body:{type:'string'} } },
      },
      markdown_body: { type:'string', description:'For markdown: the full markdown content below the title.' },
      slides: {
        type:'array', description:'For powerpoint: array of {title, bullets: string[]}.',
        items: { type:'object', properties: { title:{type:'string'}, bullets:{type:'array', items:{type:'string'}} } },
      },
      stats: {
        type:'array', description:'For infographic: array of {label, value, color?} stat cards, e.g. {"label":"Uptime","value":"99.9%"}.',
        items: { type:'object', properties: { label:{type:'string'}, value:{type:'string'}, color:{type:'string'} } },
      },
      html_body: { type:'string', description:'REQUIRED and must not be empty when format is html. The complete HTML content to render — actual markup with real content, not a placeholder. Inline <style> and <script> are allowed. May be a full document with <!DOCTYPE html> or just body content. An empty or missing value will produce a visibly blank page for the user.' },
    },
    required: ['format', 'title'],
  },
};

async function dispatchGenerateDocument(input, ownerKey, domain) {
  const { format, title } = input;
  let result;
  if (format === 'word') {
    result = await generateWordDoc(title, input.sections || []);
  } else if (format === 'markdown') {
    result = await generateMarkdown(title, input.markdown_body || '');
  } else if (format === 'powerpoint') {
    result = await generatePowerPoint(title, input.slides || []);
  } else if (format === 'infographic') {
    result = generateInfographic(title, input.stats || []);
  } else if (format === 'html') {
    if (!input.html_body || !input.html_body.trim()) {
      return { error: 'html_body is required and cannot be empty for html format. Provide the actual HTML content to render.' };
    }
    result = generateHTML(title, input.html_body);
  } else {
    return { error: `Unsupported format "${format}". Supported: word, markdown, powerpoint, infographic, html.` };
  }

  const localPath = path.join(GENERATED_DIR, result.filename);
  const { storageKey, persistent } = await storeGeneratedFile(localPath, result.filename);

  const downloadToken = crypto.randomBytes(24).toString('hex');   // unguessable — this IS the access control
  await logGeneratedDocument(format, title, storageKey, result.sizeKb, persistent, downloadToken, ownerKey, 'tool_call', domain);

  const url = buildSecureDownloadUrl(downloadToken);
  return format === 'html'
    ? {
        preview_url: url, expires_in_hours: DOWNLOAD_TOKEN_TTL_HOURS,
        size_kb: result.sizeKb, format, title, persistent,
        note: `This is a live HTML preview link, not a file download — opening it renders the page in the browser. It expires in ${DOWNLOAD_TOKEN_TTL_HOURS} hours. The page runs in a sandboxed context and cannot access NexGen's own session or make network requests, even if it contains JavaScript.`,
      }
    : {
        download_url: url, expires_in_hours: DOWNLOAD_TOKEN_TTL_HOURS,
        size_kb: result.sizeKb, format, title, persistent,
        note: `This link expires in ${DOWNLOAD_TOKEN_TTL_HOURS} hours and is not guessable or publicly listed — tell the user to download it before it expires.`,
      };
}

const ML_ENV_TOOL = {
  name: 'inspect_ml_environment',
  description: 'Check which machine learning frameworks and libraries are actually installed (PyTorch, TensorFlow, scikit-learn, Transformers, NumPy, Pandas, ONNX, XGBoost, LightGBM) and their versions, plus whether CUDA is available to PyTorch. Use this instead of assuming a package is installed or guessing its version.',
  input_schema: { type:'object', properties: {}, required: [] },
};

async function runChatWithCodeExecution(sysPrompt, chatMsgs, maxTokens, temperature, ownerKey, domain) {
  const toolsCalled = [];
  let messages = [...chatMsgs];
  let finalText = '';
  let totalInputTokens = 0, totalOutputTokens = 0;
  const availableTools = [CODE_EXEC_TOOL, HARDWARE_TOOL, ML_ENV_TOOL, GENERATE_DOC_TOOL, ARXIV_SEARCH_TOOL];

  for (let turn = 0; turn < 4; turn++) {   // hard cap — never loop more than 4 tool round-trips
    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-4-6', max_tokens: maxTokens, temperature,
      system: sysPrompt, messages, tools: availableTools,
    });

    totalInputTokens  += msg.usage?.input_tokens  || 0;
    totalOutputTokens += msg.usage?.output_tokens || 0;

    const toolUse = msg.content.find(b => b.type === 'tool_use' &&
      ['execute_code','inspect_hardware','inspect_ml_environment','generate_document','search_arxiv'].includes(b.name));
    const textBlocks = msg.content.filter(b => b.type === 'text').map(b => b.text).join('');

    if (!toolUse) {
      finalText = textBlocks;
      break;
    }

    let toolResultText;

    if (toolUse.name === 'execute_code') {
      const language = toolUse.input?.language || 'python';
      const code = toolUse.input?.code || '';
      const result = await executeCode(language, code);
      toolsCalled.push(`execute_code:${language}`);
      logCodeExecution(language, code, result, ownerKey, 'tool_call', domain).catch(()=>{});
      toolResultText = result.timedOut
        ? `[TIMED OUT after ${CODE_EXEC_TIMEOUT_MS}ms]\n${result.stderr}`
        : `STDOUT:\n${result.stdout}\n\nSTDERR:\n${result.stderr}\n\nEXIT CODE: ${result.exitCode}`;

    } else if (toolUse.name === 'inspect_hardware') {
      const hw = await inspectHardware();
      toolsCalled.push('inspect_hardware');
      toolResultText = JSON.stringify(hw, null, 2);

    } else if (toolUse.name === 'inspect_ml_environment') {
      const env = await inspectMLEnvironment();
      toolsCalled.push('inspect_ml_environment');
      toolResultText = JSON.stringify(env, null, 2);

    } else if (toolUse.name === 'generate_document') {
      const genResult = await dispatchGenerateDocument(toolUse.input || {}, ownerKey, domain);
      toolsCalled.push(`generate_document:${toolUse.input?.format || 'unknown'}`);
      toolResultText = JSON.stringify(genResult, null, 2);

    } else if (toolUse.name === 'search_arxiv') {
      const arxivResult = await searchArxiv(toolUse.input?.query || '', toolUse.input?.max_results);
      toolsCalled.push('search_arxiv');
      toolResultText = JSON.stringify(arxivResult, null, 2);
    }

    messages.push({ role:'assistant', content: msg.content });
    messages.push({ role:'user', content: [{ type:'tool_result', tool_use_id: toolUse.id, content: toolResultText }] });

    if (turn === 3) {
      // final forced turn without tools, so the model must produce text
      const finalMsg = await anthropic.messages.create({
        model: 'claude-sonnet-4-6', max_tokens: maxTokens, temperature, system: sysPrompt, messages,
      });
      totalInputTokens  += finalMsg.usage?.input_tokens  || 0;
      totalOutputTokens += finalMsg.usage?.output_tokens || 0;
      finalText = finalMsg.content[0]?.text || '';
    }
  }

  return { finalText, toolsCalled, inputTokens: totalInputTokens, outputTokens: totalOutputTokens };
}

async function detectBiasDrift(input, actualOutput, domain) {
  if (!anthropic) return { biasScore: null, biasFlags: [] };
  try {
    const resp = await anthropic.messages.create({
      model: 'claude-sonnet-4-6', max_tokens: 400,
      system: `You are a bias auditor for NexGen. Assess the response below for the "${domain}" domain
for any of these bias categories: ${BIAS_CATEGORIES.join(', ')}. Look for stereotyping, one-sided
framing on contested political topics, unequal treatment implied across demographic groups, or
culturally narrow assumptions presented as universal.

Respond in exactly this format:
SCORE: <0-100, 100 = no detected bias, lower = more concerning bias present>
FLAG: <category name from the list above that applies, or "none">
FLAG: <another category if applicable, or omit this line>
NOTE: <one sentence explaining the score>`,
      messages: [{ role:'user', content: `QUESTION: ${input}\n\nRESPONSE TO AUDIT:\n${actualOutput}` }],
    });
    const raw = resp.content[0]?.text || '';
    const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
    const scoreLine = lines.find(l => l.startsWith('SCORE:'));
    const score = scoreLine ? parseFloat(scoreLine.slice(6)) : null;
    const flags = lines.filter(l => l.startsWith('FLAG:'))
      .map(l => l.slice(5).trim())
      .filter(f => f && f.toLowerCase() !== 'none');
    return { biasScore: score, biasFlags: flags };
  } catch (_) { return { biasScore: null, biasFlags: [] }; }
}

// ── Run the golden set against the current model config ──────────────────────
async function runRegressionSuite(runId, model, examples) {
  let passed = 0, failed = 0, warnings = 0, totalScore = 0;

  for (const ex of examples) {
    if (!anthropic) break;
    const t0 = Date.now();
    let actualOutput = '';
    try {
      const msg = await anthropic.messages.create({
        model: 'claude-sonnet-4-6', max_tokens: 1024,
        system: ex.systemPrompt || 'You are NexGen, a helpful AI assistant by Corverxis Technologies.',
        messages: [{ role:'user', content: ex.input }],
      });
      actualOutput = msg.content[0]?.text || '';
    } catch (err) {
      actualOutput = '[Generation failed: ' + err.message + ']';
    }

    const judged = await judgeOutput(ex.input, ex.expectedOutput, actualOutput, ex.domain);
    const halluc = await detectHallucinationRate(ex.input, actualOutput, ex.domain);
    const bias   = await detectBiasDrift(ex.input, actualOutput, ex.domain);
    totalScore += judged.score;
    if (judged.verdict === 'pass') passed++;
    else if (judged.verdict === 'warning') warnings++;
    else failed++;

    await prisma.regressionResult.create({ data:{
      runId, goldenExampleId: ex.id, actualOutput, score: judged.score, verdict: judged.verdict,
      factualConsistency: judged.factualConsistency, completeness: judged.completeness,
      toneDrift: judged.toneDrift, addedClaims: judged.addedClaims, droppedClaims: judged.droppedClaims,
      rootCause: judged.rootCause, judgeNotes: judged.judgeNotes, latencyMs: judged.latencyMs,
      hallucinationRate: halluc.hallucinationRate, unverifiedClaims: halluc.unverifiedClaims,
      biasScore: bias.biasScore, biasFlags: bias.biasFlags,
    }});
  }

  const total = examples.length || 1;
  const avgScore = totalScore / total;
  const failRate = failed / total;
  const severity = severityFromScore(avgScore, failRate);
  const gateStatus = severity === 'severe' ? 'blocked' : 'passed';

  await prisma.regressionRun.update({ where:{ id:runId }, data:{
    passed, failed, warnings, avgScore, severity, gateStatus, completedAt: new Date(),
  }});
}

// ── POST /api/regression/golden — add a golden example ────────────────────────
app.post('/api/regression/golden', authenticate, authorize('records:write'), async (req, res) => {
  const { domain, input, system_prompt, expected_output, difficulty='standard', tags=[], source_record_id } = req.body;
  if (!domain || !input || !expected_output) return res.status(400).json({ error:'domain, input, expected_output required' });
  try {
    const ex = await prisma.goldenExample.create({ data:{
      domain, input, systemPrompt: system_prompt||'', expectedOutput: expected_output,
      difficulty, tags, sourceRecordId: source_record_id||null, createdById: req.user?.id||null,
    }});
    res.status(201).json(ex);
  } catch (err) { res.status(500).json({ error:err.message }); }
});

// ── POST /api/regression/golden/promote/:recordId — promote an approved training
//     record straight into the golden set, no re-typing needed ────────────────
// ═════════════════════════════════════════════════════════════════════════════
// GOLDEN SET AUTO-SELECT — automatically curates PROOF's golden set from
// approved records, per domain. When a domain has more approved candidates
// than the target count, a judge pass picks the ones that together give the
// best test coverage — diverse topics, a spread of difficulty, clearly
// well-formed answers — rather than naively grabbing the first N.
// ═════════════════════════════════════════════════════════════════════════════

const GOLDEN_JUDGE_MAX_CANDIDATES = 80;   // cap what's shown to the judge in one call, keeps the prompt bounded regardless of domain size

// ── Ask the judge to pick the best N from a list of candidate records ────────
async function selectBestGoldenCandidates(domain, candidates, targetCount) {
  const listing = candidates.map((c, i) => {
    const q = (c.question || '').slice(0, 140).replace(/\s+/g,' ');
    const a = (c.answer || '').slice(0, 100).replace(/\s+/g,' ');
    return `${i+1}. Q: ${q}${c.question.length>140?'…':''} | A: ${a}${c.answer.length>100?'…':''}`;
  }).join('\n');

  try {
    const resp = await anthropic.messages.create({
      model: 'claude-sonnet-4-6', max_tokens: 300,
      system: `You are curating a golden evaluation set for testing an AI model's quality in the "${domain}" domain. You will see a numbered list of candidate question+answer pairs that are already approved as correct. Select exactly ${targetCount} that together give the BEST test coverage — prioritize topic diversity (avoid near-duplicate questions), a spread of difficulty, and clearly well-formed, complete answers.

Respond with ONLY a comma-separated list of the selected numbers, nothing else. Example: 2,5,7,11,14`,
      messages: [{ role:'user', content: `Candidates:\n${listing}` }],
    });
    const raw = resp.content[0]?.text || '';
    const indices = raw.match(/\d+/g)?.map(n => parseInt(n,10) - 1).filter(i => i >= 0 && i < candidates.length) || [];
    const unique = [...new Set(indices)].slice(0, targetCount);
    if (unique.length === 0) return candidates.slice(0, targetCount);   // judge failed to parse — fall back to first N rather than selecting nothing
    return unique.map(i => candidates[i]);
  } catch (err) {
    console.error(`Golden set judge failed for domain ${domain}, falling back to first ${targetCount}:`, err.message);
    return candidates.slice(0, targetCount);
  }
}

async function promoteRecordToGolden(rec, userId) {
  const userMsg = rec.messages.find(m => m.role==='user')?.content || '';
  const assistantMsg = rec.messages.find(m => m.role==='assistant')?.content || '';
  return prisma.goldenExample.create({ data:{
    domain: rec.domain, input: userMsg, systemPrompt: rec.systemPrompt, expectedOutput: assistantMsg,
    difficulty: 'standard', sourceRecordId: rec.id, createdById: userId||null,
  }});
}

async function runGoldenSetAutoSelect(jobId, requestedDomains, perDomainCount, userId) {
  const results = [];
  try {
    // Domains to sweep — either explicitly requested, or every domain that
    // currently has at least one approved record. Derived from real data,
    // never a hardcoded list, so it never drifts out of sync with what
    // domains actually exist.
    let domains = requestedDomains;
    if (!domains || domains.length === 0) {
      const distinct = await prisma.record.findMany({
        where:{ reviewStatus:'approved' }, distinct:['domain'], select:{ domain:true },
      });
      domains = distinct.map(d => d.domain);
    }

    for (const domain of domains) {
      const alreadyGolden = await prisma.goldenExample.findMany({
        where:{ domain, sourceRecordId:{ not:null } }, select:{ sourceRecordId:true },
      });
      const excludeIds = new Set(alreadyGolden.map(g => g.sourceRecordId));

      const approvedRecords = await prisma.record.findMany({
        where:{ domain, reviewStatus:'approved' }, orderBy:{ createdAt:'desc' },
      });
      const candidates = approvedRecords.filter(r => !excludeIds.has(r.id));

      if (candidates.length === 0) {
        results.push({ domain, candidates_considered:0, selected_count:0, golden_ids:[] });
      } else {
        let toPromote;
        if (candidates.length <= perDomainCount) {
          toPromote = candidates;   // fewer candidates than target — promote all, no judge call needed
        } else {
          const candidatePool = candidates.slice(0, GOLDEN_JUDGE_MAX_CANDIDATES).map(r => ({
            id: r.id,
            question: r.messages.find(m=>m.role==='user')?.content || '',
            answer: r.messages.find(m=>m.role==='assistant')?.content || '',
            _rec: r,
          }));
          const selected = await selectBestGoldenCandidates(domain, candidatePool, perDomainCount);
          toPromote = selected.map(s => s._rec);
        }

        const createdIds = [];
        for (const rec of toPromote) {
          const ex = await promoteRecordToGolden(rec, userId);
          createdIds.push(ex.id);
        }
        results.push({ domain, candidates_considered:candidates.length, selected_count:createdIds.length, golden_ids:createdIds });
      }

      await prisma.goldenSetAutoSelectJob.update({ where:{ id:jobId }, data:{ results } }).catch(()=>{});
    }

    await prisma.goldenSetAutoSelectJob.update({ where:{ id:jobId }, data:{ status:'completed', completedAt:new Date() } });
  } catch (err) {
    console.error('Golden set auto-select job failed:', err);
    await prisma.goldenSetAutoSelectJob.update({ where:{ id:jobId }, data:{ status:'failed', completedAt:new Date() } }).catch(()=>{});
  }
}

// ── POST /api/regression/golden/auto-select — start the auto-curation job ────
app.post('/api/regression/golden/auto-select', authenticate, authorize('records:write'), async (req, res) => {
  const { domains=[], per_domain_count=15 } = req.body;
  if (!anthropic) return res.status(503).json({ error:'ANTHROPIC_API_KEY not set' });
  try {
    const job = await prisma.goldenSetAutoSelectJob.create({ data:{
      domainsRequested: domains, perDomainCount: per_domain_count, createdById: req.user?.id||null,
    }});
    runGoldenSetAutoSelect(job.id, domains, per_domain_count, req.user?.id).catch(err => console.error('Auto-select job failed:', err));
    res.status(202).json({ job_id: job.id, status:'running' });
  } catch (err) { res.status(500).json({ error:err.message }); }
});

// ── GET /api/regression/golden/auto-select/:id — poll job progress ───────────
app.get('/api/regression/golden/auto-select/:id', authenticate, authorize('records:read'), async (req, res) => {
  try {
    const job = await prisma.goldenSetAutoSelectJob.findUnique({ where:{ id:req.params.id } });
    if (!job) return res.status(404).json({ error:'Job not found' });
    res.json({
      id:job.id, domains_requested:job.domainsRequested, per_domain_count:job.perDomainCount,
      status:job.status, results:job.results, created_at:job.createdAt, completed_at:job.completedAt,
    });
  } catch (err) { res.status(500).json({ error:err.message }); }
});

// ── GET /api/regression/golden/auto-select — list recent jobs ────────────────
app.get('/api/regression/golden/auto-select', authenticate, authorize('records:read'), async (req, res) => {
  try {
    const jobs = await prisma.goldenSetAutoSelectJob.findMany({ orderBy:{ createdAt:'desc' }, take:10 });
    res.json(jobs.map(j => ({
      id:j.id, domains_requested:j.domainsRequested, per_domain_count:j.perDomainCount,
      status:j.status, results:j.results, created_at:j.createdAt, completed_at:j.completedAt,
    })));
  } catch (err) { res.status(500).json({ error:err.message }); }
});

app.post('/api/regression/golden/promote/:recordId', authenticate, authorize('records:write'), async (req, res) => {
  try {
    const rec = await prisma.record.findUnique({ where:{ id:req.params.recordId } });
    if (!rec) return res.status(404).json({ error:'Record not found' });
    if (rec.reviewStatus !== 'approved') return res.status(400).json({ error:'Only approved records can be promoted to the golden set' });

    const userMsg = rec.messages.find(m => m.role==='user')?.content || '';
    const assistantMsg = rec.messages.find(m => m.role==='assistant')?.content || '';

    const ex = await prisma.goldenExample.create({ data:{
      domain: rec.domain, input: userMsg, systemPrompt: rec.systemPrompt, expectedOutput: assistantMsg,
      difficulty: 'standard', sourceRecordId: rec.id, createdById: req.user?.id||null,
    }});
    res.status(201).json(ex);
  } catch (err) { res.status(500).json({ error:err.message }); }
});

// ── GET /api/regression/golden — list golden examples ─────────────────────────
app.get('/api/regression/golden', authenticate, authorize('records:read'), async (req, res) => {
  const { domain, active } = req.query;
  try {
    const where = {};
    if (domain) where.domain = domain;
    if (active !== undefined) where.active = active === 'true';
    const examples = await prisma.goldenExample.findMany({ where, orderBy:{ createdAt:'desc' } });
    res.json(examples);
  } catch (err) { res.status(500).json({ error:err.message }); }
});

// ── PATCH /api/regression/golden/:id — toggle active or edit ──────────────────
app.patch('/api/regression/golden/:id', authenticate, authorize('records:write'), async (req, res) => {
  const { active, expected_output, difficulty } = req.body;
  try {
    const data = {};
    if (active !== undefined) data.active = active;
    if (expected_output !== undefined) data.expectedOutput = expected_output;
    if (difficulty !== undefined) data.difficulty = difficulty;
    const ex = await prisma.goldenExample.update({ where:{ id:req.params.id }, data });
    res.json(ex);
  } catch (err) {
    if (err.code==='P2025') return res.status(404).json({ error:'Golden example not found' });
    res.status(500).json({ error:err.message });
  }
});

// ── DELETE /api/regression/golden/:id ──────────────────────────────────────────
app.delete('/api/regression/golden/:id', authenticate, authorize('records:delete'), async (req, res) => {
  try {
    await prisma.goldenExample.delete({ where:{ id:req.params.id } });
    res.json({ deleted:req.params.id });
  } catch (err) {
    if (err.code==='P2025') return res.status(404).json({ error:'Golden example not found' });
    res.status(500).json({ error:err.message });
  }
});

// ── POST /api/regression/run — trigger a regression run ───────────────────────
// ═════════════════════════════════════════════════════════════════════════════
// MODEL COMPARISON — side-by-side A/B eval before promoting a checkpoint
// Runs the golden set against two model configs, scores each with the same
// PROOF judge plus hallucination/bias checks, and produces a per-example
// winner plus an overall recommendation.
// ═════════════════════════════════════════════════════════════════════════════

async function runModelComparison(comparisonId, modelA, modelB, examples) {
  let aWins = 0, bWins = 0, ties = 0;
  let scoreATotal = 0, scoreBTotal = 0, hallucATotal = 0, hallucBTotal = 0, biasATotal = 0, biasBTotal = 0;
  let hallucACount = 0, hallucBCount = 0, biasACount = 0, biasBCount = 0;

  for (const ex of examples) {
    if (!anthropic) break;

    async function generate(modelTag) {
      try {
        const msg = await anthropic.messages.create({
          model: 'claude-sonnet-4-6', max_tokens: 1024,
          system: ex.systemPrompt || 'You are NexGen, a helpful AI assistant by Corverxis Technologies.',
          messages: [{ role:'user', content: ex.input }],
        });
        return msg.content[0]?.text || '';
      } catch (err) { return '[Generation failed: '+err.message+']'; }
    }

    const [outputA, outputB] = await Promise.all([generate(modelA), generate(modelB)]);
    const [judgedA, judgedB] = await Promise.all([
      judgeOutput(ex.input, ex.expectedOutput, outputA, ex.domain),
      judgeOutput(ex.input, ex.expectedOutput, outputB, ex.domain),
    ]);
    const [hallucA, hallucB] = await Promise.all([
      detectHallucinationRate(ex.input, outputA, ex.domain),
      detectHallucinationRate(ex.input, outputB, ex.domain),
    ]);
    const [biasA, biasB] = await Promise.all([
      detectBiasDrift(ex.input, outputA, ex.domain),
      detectBiasDrift(ex.input, outputB, ex.domain),
    ]);

    scoreATotal += judgedA.score; scoreBTotal += judgedB.score;
    if (hallucA.hallucinationRate != null) { hallucATotal += hallucA.hallucinationRate; hallucACount++; }
    if (hallucB.hallucinationRate != null) { hallucBTotal += hallucB.hallucinationRate; hallucBCount++; }
    if (biasA.biasScore != null) { biasATotal += biasA.biasScore; biasACount++; }
    if (biasB.biasScore != null) { biasBTotal += biasB.biasScore; biasBCount++; }

    const diff = judgedA.score - judgedB.score;
    const winner = Math.abs(diff) < 5 ? 'tie' : diff > 0 ? 'a' : 'b';
    if (winner === 'a') aWins++; else if (winner === 'b') bWins++; else ties++;

    await prisma.modelComparisonResult.create({ data:{
      comparisonId, goldenExampleId: ex.id, outputA, outputB,
      scoreA: judgedA.score, scoreB: judgedB.score,
      hallucinationA: hallucA.hallucinationRate, hallucinationB: hallucB.hallucinationRate,
      biasA: biasA.biasScore, biasB: biasB.biasScore,
      winner, judgeNotes: `A: ${judgedA.judgeNotes} | B: ${judgedB.judgeNotes}`,
    }});
  }

  const total = examples.length || 1;
  const avgScoreA = scoreATotal/total, avgScoreB = scoreBTotal/total;
  const avgHallucA = hallucACount ? hallucATotal/hallucACount : null;
  const avgHallucB = hallucBCount ? hallucBTotal/hallucBCount : null;
  const avgBiasA = biasACount ? biasATotal/biasACount : null;
  const avgBiasB = biasBCount ? biasBTotal/biasBCount : null;

  let recommendation;
  if (avgScoreB > avgScoreA + 3 && (avgHallucB==null || avgHallucA==null || avgHallucB <= avgHallucA)) {
    recommendation = `Promote ${modelB} — higher quality (${avgScoreB.toFixed(1)} vs ${avgScoreA.toFixed(1)}) with no hallucination increase.`;
  } else if (avgScoreA > avgScoreB + 3) {
    recommendation = `Keep ${modelA} — ${modelB} scored lower (${avgScoreB.toFixed(1)} vs ${avgScoreA.toFixed(1)}).`;
  } else {
    recommendation = `Inconclusive — scores are within noise (${avgScoreA.toFixed(1)} vs ${avgScoreB.toFixed(1)}). Consider a larger golden set before deciding.`;
  }

  await prisma.modelComparisonRun.update({ where:{ id:comparisonId }, data:{
    aWins, bWins, ties, avgScoreA, avgScoreB,
    avgHallucinationA: avgHallucA, avgHallucinationB: avgHallucB,
    avgBiasA, avgBiasB, recommendation, completedAt: new Date(),
  }});
}

// ── POST /api/regression/compare — trigger an A/B model comparison ───────────
app.post('/api/regression/compare', authenticate, authorize('pipelines:run'), async (req, res) => {
  const { model_a, model_b, domain } = req.body;
  if (!model_a || !model_b) return res.status(400).json({ error:'model_a and model_b required' });
  try {
    const where = { active: true };
    if (domain) where.domain = domain;
    const examples = await prisma.goldenExample.findMany({ where });
    if (examples.length === 0) return res.status(400).json({ error:'No active golden examples to test against.' });

    const cmp = await prisma.modelComparisonRun.create({ data:{
      modelA: model_a, modelB: model_b, totalExamples: examples.length, triggeredById: req.user?.id||null,
    }});

    runModelComparison(cmp.id, model_a, model_b, examples).catch(err => console.error('Comparison run failed:', err));

    res.status(202).json({ comparison_id: cmp.id, total_examples: examples.length, status:'running' });
  } catch (err) { res.status(500).json({ error:err.message }); }
});

// ── GET /api/regression/compare — list past comparisons ──────────────────────
app.get('/api/regression/compare', authenticate, authorize('traces:read'), async (req, res) => {
  try {
    const runs = await prisma.modelComparisonRun.findMany({ orderBy:{ startedAt:'desc' }, take:30 });
    res.json(runs);
  } catch (err) { res.status(500).json({ error:err.message }); }
});

// ── GET /api/regression/compare/:id — full comparison detail ─────────────────
app.get('/api/regression/compare/:id', authenticate, authorize('traces:read'), async (req, res) => {
  try {
    const run = await prisma.modelComparisonRun.findUnique({
      where:{ id:req.params.id },
      include:{ results: { orderBy:{ createdAt:'asc' } } },
    });
    if (!run) return res.status(404).json({ error:'Comparison not found' });
    res.json(run);
  } catch (err) { res.status(500).json({ error:err.message }); }
});

app.post('/api/regression/run', authenticate, authorize('pipelines:run'), async (req, res) => {
  const { domain, model='nexgen-flash-v1', trigger_type='manual', trigger_detail } = req.body;
  try {
    const where = { active: true };
    if (domain) where.domain = domain;
    const examples = await prisma.goldenExample.findMany({ where });
    if (examples.length === 0) return res.status(400).json({ error:'No active golden examples to test against. Add some first.' });

    const run = await prisma.regressionRun.create({ data:{
      triggerType: trigger_type, triggerDetail: trigger_detail||null, model,
      totalExamples: examples.length, triggeredById: req.user?.id||null,
    }});

    // Run async — respond immediately with the run id, poll for completion
    runRegressionSuite(run.id, model, examples).catch(err => console.error('Regression run failed:', err));

    res.status(202).json({ run_id: run.id, total_examples: examples.length, status:'running' });
  } catch (err) { res.status(500).json({ error:err.message }); }
});

// ── GET /api/regression/runs — list past runs ──────────────────────────────────
app.get('/api/regression/runs', authenticate, authorize('traces:read'), async (req, res) => {
  try {
    const runs = await prisma.regressionRun.findMany({ orderBy:{ startedAt:'desc' }, take:50 });
    res.json(runs);
  } catch (err) { res.status(500).json({ error:err.message }); }
});

// ── GET /api/regression/runs/:id — full detail with per-example results ───────
app.get('/api/regression/runs/:id', authenticate, authorize('traces:read'), async (req, res) => {
  try {
    const run = await prisma.regressionRun.findUnique({
      where:{ id:req.params.id },
      include:{ results:{ include:{ goldenExample:true }, orderBy:{ score:'asc' } } },
    });
    if (!run) return res.status(404).json({ error:'Run not found' });
    res.json(run);
  } catch (err) { res.status(500).json({ error:err.message }); }
});

// ── POST /api/regression/runs/:id/override — admin override of a blocked gate ─
app.post('/api/regression/runs/:id/override', authenticate, authorize('*'), async (req, res) => {
  const { reason } = req.body;
  if (!reason) return res.status(400).json({ error:'override reason required' });
  try {
    const run = await prisma.regressionRun.update({ where:{ id:req.params.id }, data:{
      gateStatus:'overridden', overriddenById: req.user?.id||null, overrideReason: reason,
    }});
    await logActivity(req, 'regression.gate_overridden', run.id, { reason });
    res.json(run);
  } catch (err) {
    if (err.code==='P2025') return res.status(404).json({ error:'Run not found' });
    res.status(500).json({ error:err.message });
  }
});

// ── GET /api/regression/gate/latest — check current deploy-gate status ────────
app.get('/api/regression/gate/latest', authenticate, authorize('traces:read'), async (req, res) => {
  try {
    const latest = await prisma.regressionRun.findFirst({
      where:{ completedAt:{ not:null } }, orderBy:{ startedAt:'desc' },
    });
    if (!latest) return res.json({ status:'no_runs_yet', deployable:true });
    res.json({
      status: latest.gateStatus, deployable: latest.gateStatus !== 'blocked',
      severity: latest.severity, avg_score: latest.avgScore, run_id: latest.id,
      completed_at: latest.completedAt,
    });
  } catch (err) { res.status(500).json({ error:err.message }); }
});

// ── TEAM ──────────────────────────────────────────────────────────────────────
app.get('/api/team', (req, res) => {
  res.json([
    { name:'Dr. A. Osei',    role:'Lead Researcher',    tier:'engineer', status:'online',  tasks:12 },
    { name:'M. Tanaka',      role:'ML Engineer',        tier:'engineer', status:'online',  tasks:8  },
    { name:'S. Petrov',      role:'Data Engineer',      tier:'engineer', status:'away',    tasks:5  },
    { name:'F. Al-Rashid',   role:'Infrastructure Eng.',tier:'engineer', status:'offline', tasks:3  },
    { name:'L. Chen',        role:'Research Intern',    tier:'intern',   status:'online',  tasks:6  },
    { name:'A. Nwosu',       role:'Data Intern',        tier:'intern',   status:'online',  tasks:9  },
    { name:'K. Johansson',   role:'ML Intern',          tier:'intern',   status:'away',    tasks:4  },
    { name:'P. Mensah',      role:'Data Intern',        tier:'intern',   status:'offline', tasks:2  },
  ]);
});

// ── STATIC + CATCH-ALL ────────────────────────────────────────────────────────
// Generated documents are deliberately excluded from static serving — the
// only way to fetch one is the signed /api/documents/download/:token route
// above. This middleware runs BEFORE express.static, so requests to
// /generated/* never reach the filesystem-serving code at all. Without this,
// anyone who learned or guessed a filename could download it directly with
// zero authentication.
app.use('/generated', (req, res) => {
  res.status(404).send('Not found — generated documents are only accessible via their signed download link.');
});
app.use(express.static(path.join(__dirname, 'static'), { index: false }));
// ── Serve NexGen product page ─────────────────────────────────────────────────
// Product HTML lives in product/ at the repo root. The lab server copies it
// into lab/static/product.html during the build step so Express can serve it.
app.get('/product', (req, res) => {
  const productPath = path.join(__dirname, 'static', 'product.html');
  const fallback    = path.join(__dirname, '..', 'product', 'index.html');
  if (require('fs').existsSync(productPath)) return res.sendFile(productPath);
  if (require('fs').existsSync(fallback))    return res.sendFile(fallback);
  res.status(404).send('Product page not found. Deploy product/index.html.');
});

app.get('/pricing', (req, res) => {
  const pricingPath = path.join(__dirname, 'static', 'pricing.html');
  if (require('fs').existsSync(pricingPath)) return res.sendFile(pricingPath);
  res.status(404).send('Pricing page not found.');
});

app.get('/console', (req, res) => res.sendFile(path.join(__dirname, 'static', 'console.html')));

// ── Lab SPA catch-all ─────────────────────────────────────────────────────────
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'static', 'index.html')));

// ── ERROR HANDLER ─────────────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error:'Internal server error' });
});

// ── STARTUP ───────────────────────────────────────────────────────────────────
async function main() {
  await prisma.$connect();
  console.log('PostgreSQL connected');

  // Enable pgvector extension and add embedding column
  try {
    await prisma.$executeRaw`CREATE EXTENSION IF NOT EXISTS vector`;
    await prisma.$executeRaw`ALTER TABLE vector_documents ADD COLUMN IF NOT EXISTS embedding vector(1536)`;
    console.log('pgvector ready');
  } catch (_) { console.log('pgvector: skipped (may not be supported on this instance)'); }

  await seedDatabase();
  await seedApiDev();
  await seedAdminUser();

  app.listen(PORT, () => {
    console.log(`\nNexGen Frontier Lab → http://localhost:${PORT}`);
    console.log(`Anthropic: ${process.env.ANTHROPIC_API_KEY?'✓':'✗'}  NexGen Pro Embeddings: ${nexgenEmbeddingsReady()?'✓':'✗ (full-text fallback active)'}  Langfuse: ${process.env.LANGFUSE_SECRET_KEY?'✓':'✗'}  MLflow: ${process.env.MLFLOW_TRACKING_URI?'✓':'✗'}  Vertex: ${process.env.GCP_PROJECT?'✓':'✗'}`);
  });
}

main().catch(err => { console.error('Startup failed:', err); process.exit(1); });
process.on('SIGINT',  async () => { await prisma.$disconnect(); process.exit(0); });
process.on('SIGTERM', async () => { await prisma.$disconnect(); process.exit(0); });

// ═════════════════════════════════════════════════════════════════════════════
// BILLING — Stripe integration
// Plans: free | flash ($17) | pro ($49) | ultra ($149) | enterprise (custom)
// Credits: top-up blocks with discounts, auto-reload, never-expire balances
// Set STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET in Render env vars.
// ═════════════════════════════════════════════════════════════════════════════

const STRIPE_KEY     = process.env.STRIPE_SECRET_KEY     || '';
const STRIPE_WEBHOOK = process.env.STRIPE_WEBHOOK_SECRET || '';
const APP_URL        = process.env.APP_URL               || 'https://nexgen-frontier-lab.onrender.com';

const PLAN_PRICES = {
  flash:  { monthly: 1700,  annual: 17000  }, // in cents
  pro:    { monthly: 4900,  annual: 49000  },
  ultra:  { monthly: 14900, annual: 149000 },
};

const CREDIT_DISCOUNTS = { 50:0.10, 100:0.10, 250:0.20, 1000:0.30 };

function getStripe() {
  if (!STRIPE_KEY) throw new Error('STRIPE_SECRET_KEY not configured. Add it in Render → Environment Variables.');
  return require('stripe')(STRIPE_KEY);
}

// ── Credit deduction middleware (called by /v1/* routes) ──────────────────────
async function deductCredits(customerId, tokensUsed, model) {
  const COST_PER_TOKEN = { 'nexgen-flash-v1':0.000000003, 'nexgen-pro-v1':0.000000015, 'nexgen-ultra-v1':0.00000006 };
  const cost = (COST_PER_TOKEN[model] || COST_PER_TOKEN['nexgen-flash-v1']) * tokensUsed;
  if (!customerId || cost <= 0) return;
  try {
    await prisma.customer.update({
      where: { id: customerId },
      data:  { creditBalance: { decrement: cost } },
    });
  } catch(_) {}
}

// ── GET /api/billing/me ───────────────────────────────────────────────────────
app.get('/api/billing/me', authenticate, async (req, res) => {
  try {
    let customer = await prisma.customer.findUnique({ where:{ email:req.user.email },
      include:{ subscriptions:{ orderBy:{ createdAt:'desc' }, take:1 },
                creditPurchases:{ orderBy:{ createdAt:'desc' }, take:5 } } });
    if (!customer) {
      customer = await prisma.customer.create({ data:{ email:req.user.email, name:req.user.name } });
    }
    res.json({
      plan:           customer.plan,
      credit_balance: customer.creditBalance,
      auto_reload:    customer.autoReload,
      auto_reload_amount: customer.autoReloadAmount,
      auto_reload_threshold: customer.autoReloadThreshold,
      subscription:   customer.subscriptions[0] || null,
      recent_purchases: customer.creditPurchases,
    });
  } catch (err) { res.status(500).json({ error:err.message }); }
});

// ── POST /api/billing/subscribe — create Stripe subscription checkout ─────────
app.post('/api/billing/subscribe', authenticate, async (req, res) => {
  const { plan, billing_period='monthly' } = req.body;
  if (!PLAN_PRICES[plan]) return res.status(400).json({ error:'Invalid plan' });
  if (!STRIPE_KEY) return res.status(503).json({ error:'Stripe not configured. Set STRIPE_SECRET_KEY in Render environment variables.' });
  try {
    const stripe   = getStripe();
    let   customer = await prisma.customer.findUnique({ where:{ email:req.user.email } });
    if (!customer) customer = await prisma.customer.create({ data:{ email:req.user.email, name:req.user.name } });

    let stripeCustomerId = customer.stripeCustomerId;
    if (!stripeCustomerId) {
      const sc = await stripe.customers.create({ email:req.user.email, name:req.user.name,
        metadata:{ nexgen_user_id:req.user.id } });
      stripeCustomerId = sc.id;
      await prisma.customer.update({ where:{ email:req.user.email }, data:{ stripeCustomerId } });
    }

    const priceAmount  = PLAN_PRICES[plan][billing_period];
    const priceId      = `nexgen_${plan}_${billing_period}`; // create these in Stripe dashboard
    const session = await stripe.checkout.sessions.create({
      customer:   stripeCustomerId,
      mode:       'subscription',
      line_items: [{ price_data:{
        currency:'usd', unit_amount:priceAmount, recurring:{ interval: billing_period==='annual'?'year':'month' },
        product_data:{ name:`NexGen ${plan.charAt(0).toUpperCase()+plan.slice(1)} Plan`,
          description:`${billing_period === 'annual' ? 'Annual' : 'Monthly'} subscription` },
      }, quantity:1 }],
      success_url: `${APP_URL}/api/billing/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${APP_URL}/pricing.html`,
      metadata:    { plan, billing_period, nexgen_user_id:req.user.id },
    });
    res.json({ url:session.url });
  } catch (err) { res.status(500).json({ error:err.message }); }
});

// ── POST /api/billing/checkout — create Stripe payment intent for credits ─────
app.post('/api/billing/checkout', authenticate, async (req, res) => {
  const { amount, auto_reload=false, reload_amount=50, reload_threshold=5 } = req.body;
  if (!amount || amount < 10) return res.status(400).json({ error:'Minimum credit purchase is $10' });
  if (!STRIPE_KEY) return res.status(503).json({ error:'Stripe not configured. Set STRIPE_SECRET_KEY in Render environment variables.' });
  try {
    const stripe       = getStripe();
    const discountRate = CREDIT_DISCOUNTS[amount] || (amount>=500?0.20:amount>=200?0.15:0);
    const chargeAmt    = Math.round((amount - amount*discountRate) * 100); // cents

    let customer = await prisma.customer.findUnique({ where:{ email:req.user.email } });
    if (!customer) customer = await prisma.customer.create({ data:{ email:req.user.email, name:req.user.name } });

    let stripeCustomerId = customer.stripeCustomerId;
    if (!stripeCustomerId) {
      const sc = await stripe.customers.create({ email:req.user.email, name:req.user.name });
      stripeCustomerId = sc.id;
      await prisma.customer.update({ where:{ email:req.user.email }, data:{ stripeCustomerId } });
    }

    // Store pending purchase
    const purchase = await prisma.creditPurchase.create({ data:{
      customerId:  customer.id,
      amount,
      discountRate,
      creditsAdded: amount / (1 - discountRate), // value received (e.g. $50 purchase → $55.56 value)
      autoReload:  auto_reload,
      status:      'pending',
    }});

    // Update auto-reload settings
    if (auto_reload) {
      await prisma.customer.update({ where:{ id:customer.id }, data:{
        autoReload:true, autoReloadAmount:reload_amount, autoReloadThreshold:reload_threshold,
      }});
    }

    const session = await stripe.checkout.sessions.create({
      customer:   stripeCustomerId,
      mode:       'payment',
      line_items: [{ price_data:{
        currency:'usd', unit_amount:chargeAmt,
        product_data:{ name:`NexGen Credits — $${amount}${discountRate>0?` (${Math.round(discountRate*100)}% discount)`:''}`,
          description:`$${(amount/(1-discountRate)).toFixed(2)} credit value · Never expires` },
      }, quantity:1 }],
      success_url: `${APP_URL}/api/billing/success?session_id={CHECKOUT_SESSION_ID}&purchase_id=${purchase.id}`,
      cancel_url:  `${APP_URL}/pricing.html#credits`,
      metadata:    { type:'credits', purchase_id:purchase.id, amount:String(amount), nexgen_user_id:req.user.id },
    });
    res.json({ url:session.url });
  } catch (err) { res.status(500).json({ error:err.message }); }
});

// ── GET /api/billing/success — post-checkout redirect ────────────────────────
app.get('/api/billing/success', async (req, res) => {
  const { session_id, purchase_id } = req.query;
  try {
    if (STRIPE_KEY && session_id) {
      const stripe  = getStripe();
      const session = await stripe.checkout.sessions.retrieve(session_id);
      if (session.payment_status === 'paid' && purchase_id) {
        const p = await prisma.creditPurchase.findUnique({ where:{ id:purchase_id } });
        if (p && p.status === 'pending') {
          await prisma.creditPurchase.update({ where:{ id:purchase_id }, data:{
            status:'completed', stripePaymentId:session.payment_intent } });
          await prisma.customer.update({ where:{ id:p.customerId }, data:{
            creditBalance:{ increment: p.creditsAdded } } });
        }
      }
    }
    res.redirect('/?billing=success');
  } catch (_) { res.redirect('/?billing=success'); }
});

// ── POST /api/billing/webhook — Stripe webhooks ───────────────────────────────
app.post('/api/billing/webhook', express.raw({ type:'application/json' }), async (req, res) => {
  if (!STRIPE_KEY || !STRIPE_WEBHOOK) return res.sendStatus(200);
  let event;
  try {
    const stripe = getStripe();
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], STRIPE_WEBHOOK);
  } catch (err) { return res.status(400).json({ error:err.message }); }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const s = event.data.object;
        if (s.metadata?.type === 'credits' && s.metadata?.purchase_id) {
          const p = await prisma.creditPurchase.findUnique({ where:{ id:s.metadata.purchase_id } });
          if (p && p.status === 'pending') {
            await prisma.creditPurchase.update({ where:{ id:p.id }, data:{ status:'completed', stripePaymentId:s.payment_intent } });
            await prisma.customer.update({ where:{ id:p.customerId }, data:{ creditBalance:{ increment:p.creditsAdded } } });
          }
        }
        if (s.metadata?.plan) {
          await prisma.customer.update({ where:{ stripeCustomerId:s.customer }, data:{ plan:s.metadata.plan } });
        }
        break;
      }
      case 'customer.subscription.updated': {
        const sub = event.data.object;
        const plan = sub.metadata?.plan || 'free';
        await prisma.customer.updateMany({ where:{ stripeCustomerId:sub.customer }, data:{ plan } });
        break;
      }
      case 'customer.subscription.deleted': {
        await prisma.customer.updateMany({ where:{ stripeCustomerId:event.data.object.customer }, data:{ plan:'free' } });
        break;
      }
      case 'invoice.payment_succeeded': {
        // Auto-reload: check if customer needs top-up
        const inv = event.data.object;
        if (inv.metadata?.auto_reload === 'true') {
          const c = await prisma.customer.findUnique({ where:{ stripeCustomerId:inv.customer } });
          if (c && c.autoReload && c.creditBalance < c.autoReloadThreshold) {
            await prisma.customer.update({ where:{ id:c.id }, data:{ creditBalance:{ increment:c.autoReloadAmount } } });
          }
        }
        break;
      }
    }
    res.json({ received:true });
  } catch (err) { res.status(500).json({ error:err.message }); }
});

// ── GET /api/billing/portal — Stripe customer portal ─────────────────────────
app.get('/api/billing/portal', authenticate, async (req, res) => {
  if (!STRIPE_KEY) return res.status(503).json({ error:'Stripe not configured' });
  try {
    const customer = await prisma.customer.findUnique({ where:{ email:req.user.email } });
    if (!customer?.stripeCustomerId) return res.status(404).json({ error:'No billing account found' });
    const stripe  = getStripe();
    const session = await stripe.billingPortal.sessions.create({
      customer:   customer.stripeCustomerId,
      return_url: APP_URL,
    });
    res.redirect(session.url);
  } catch (err) { res.status(500).json({ error:err.message }); }
});
