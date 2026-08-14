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
function getOpenAI()     { return new (require('openai'))({ apiKey: process.env.OPENAI_API_KEY }); }
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

// ── Transform helpers ─────────────────────────────────────────────────────────
const toRecord   = r => ({ id:r.id, domain:r.domain, system:r.systemPrompt, messages:r.messages, review_status:r.reviewStatus, created_at:r.createdAt });
const toJob      = j => ({ id:j.id, tier:j.tier, base_model:j.baseModel, record_count:j.recordCount, epochs:j.epochs, seq_len:j.seqLen, lora_r:j.loraR, lr:j.lr, status:j.status, created_at:j.createdAt });
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
      openai_set:       !!process.env.OPENAI_API_KEY,
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

app.post('/api/records', authenticate, authorize('records:write'), async (req, res) => {
  const { domain, system_prompt, messages, review_status='needs_review' } = req.body;
  if (!domain || !system_prompt || !Array.isArray(messages))
    return res.status(400).json({ error:'domain, system_prompt, and messages[] required' });
  if (messages[0]?.role !== 'user')
    return res.status(400).json({ error:'messages must start with a user turn' });
  if (messages[messages.length-1]?.role !== 'assistant')
    return res.status(400).json({ error:'messages must end with an assistant turn' });
  try {
    const r = await prisma.record.create({ data:{ domain, systemPrompt:system_prompt, messages, reviewStatus:review_status } });
    res.status(201).json(toRecord(r));
  } catch (err) { res.status(500).json({ error:err.message }); }
});

app.patch('/api/records/:id/status', async (req, res) => {
  const allowed = ['approved','needs_review','rejected'];
  if (!allowed.includes(req.body.status))
    return res.status(400).json({ error:`status must be one of: ${allowed.join(', ')}` });
  try {
    const r = await prisma.record.update({ where:{ id:req.params.id }, data:{ reviewStatus:req.body.status } });
    res.json(toRecord(r));
  } catch (err) {
    if (err.code==='P2025') return res.status(404).json({ error:'Record not found' });
    res.status(500).json({ error:err.message });
  }
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

app.post('/api/jobs', authenticate, authorize('jobs:write'), async (req, res) => {
  const { tier, base_model, record_count=0, epochs=3, seq_len=4096, lora_r=32, lr=0.0001 } = req.body;
  if (!tier || !base_model) return res.status(400).json({ error:'tier and base_model required' });
  try {
    const j = await prisma.job.create({ data:{ tier, baseModel:base_model, recordCount:record_count, epochs, seqLen:seq_len, loraR:lora_r, lr, status:'queued' } });
    res.status(201).json(toJob(j));
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
        if (process.env.OPENAI_API_KEY) {
          const oai = getOpenAI();
          const embed = await oai.embeddings.create({ model:'text-embedding-3-small', input });
          const vec = `[${embed.data[0].embedding.join(',')}]`;
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

      // Embed with OpenAI if available, else skip embedding
      if (process.env.OPENAI_API_KEY) {
        try {
          const oai = getOpenAI();
          const resp = await oai.embeddings.create({ model:'text-embedding-3-small', input:chunks[idx] });
          const vec  = `[${resp.data[0].embedding.join(',')}]`;
          await prisma.$executeRaw`
            UPDATE vector_documents SET embedding = ${vec}::vector WHERE id = ${doc.id}`;
        } catch (_) {}
      }
      created.push(doc);
    }
    res.status(201).json({ chunks_created:created.length, documents:created });
  } catch (err) { res.status(500).json({ error:err.message }); }
});

app.delete('/api/rag/documents/:id', async (req, res) => {
  try {
    await prisma.vectorDocument.delete({ where:{ id:req.params.id } });
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
    if (process.env.OPENAI_API_KEY) {
      const oai = getOpenAI();
      const embed = await oai.embeddings.create({ model:'text-embedding-3-small', input:query });
      const vec = `[${embed.data[0].embedding.join(',')}]`;
      results = await prisma.$queryRaw`
        SELECT id, content, metadata, source, chunk_idx,
               round((embedding <=> ${vec}::vector)::numeric, 4) AS distance
        FROM vector_documents WHERE embedding IS NOT NULL
        ORDER BY embedding <=> ${vec}::vector LIMIT ${top_k}`;
      method = 'pgvector';
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
app.post('/api/generate', async (req, res) => {
  if (!anthropic) return res.status(503).json({ error:'ANTHROPIC_API_KEY not set' });
  const { domain, topic, system_prompt } = req.body;
  if (!domain || !topic || !system_prompt) return res.status(400).json({ error:'domain, topic, system_prompt required' });
  try {
    const msg = await anthropic.messages.create({
      model:'claude-sonnet-4-6', max_tokens:1024,
      messages:[{ role:'user', content:`Generate ONE NexGen LLM training record for the "${domain}" domain.\nTopic: ${topic}\nSystem: "${system_prompt}"\nReturn ONLY valid JSON (no fences): {"id":"nexgen-${domain}-XXXXXX","domain":"${domain}","system":"${system_prompt}","messages":[{"role":"user","content":"..."},{"role":"assistant","content":"..."}],"review_status":"needs_review"}\nRequirements: realistic question, accurate answer, appropriate disclaimers for clinical/legal/finance/engineering/mining_safety domains, end on assistant turn.` }]
    });
    const record = JSON.parse(msg.content[0].text.replace(/```json|```/g,'').trim());
    record.id = `nexgen-${domain}-${Date.now()}`;
    res.json(record);
  } catch (err) {
    if (err instanceof SyntaxError) return res.status(500).json({ error:'Model returned invalid JSON — retry with a different topic' });
    res.status(500).json({ error:err.message });
  }
});

app.post('/api/validate', async (req, res) => {
  if (!anthropic) return res.status(503).json({ error:'ANTHROPIC_API_KEY not set' });
  const { record } = req.body;
  if (!record) return res.status(400).json({ error:'record required' });
  try {
    const msg = await anthropic.messages.create({
      model:'claude-sonnet-4-6', max_tokens:512,
      messages:[{ role:'user', content:`Review this LLM training record. Return ONLY JSON (no fences):\n{"score":0-10,"strengths":["..."],"issues":["..."],"recommendation":"approve|revise|reject"}\n\nRecord:\n${JSON.stringify(record,null,2)}\n\nCheck: role alternation, starts user ends assistant, has system, factual accuracy, clarity, safety disclaimers for clinical/legal/finance/engineering/mining_safety.` }]
    });
    res.json(JSON.parse(msg.content[0].text.replace(/```json|```/g,'').trim()));
  } catch (err) {
    if (err instanceof SyntaxError) return res.status(500).json({ error:'Validation returned invalid JSON — retry' });
    res.status(500).json({ error:err.message });
  }
});

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
    // Return the full key ONCE — it will never be returned again
    res.status(201).json({ ...toApiKey(k), key });
  } catch (err) { res.status(500).json({ error:err.message }); }
});

app.patch('/api/dev/keys/:id/revoke', async (req, res) => {
  try {
    const k = await prisma.apiKey.update({ where:{ id:req.params.id }, data:{ status:'revoked' } });
    res.json(toApiKey(k));
  } catch (err) {
    if (err.code==='P2025') return res.status(404).json({ error:'Key not found' });
    res.status(500).json({ error:err.message });
  }
});

app.delete('/api/dev/keys/:id', async (req, res) => {
  try {
    await prisma.apiKey.delete({ where:{ id:req.params.id } });
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
        if (process.env.OPENAI_API_KEY) {
          const oai = getOpenAI();
          const emb = await oai.embeddings.create({ model:'text-embedding-3-small', input:query });
          const vec = `[${emb.data[0].embedding.join(',')}]`;
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
          temperature=0.7, stream=false } = req.body;

  if (!messages.length) {
    return res.status(422).json({ error:{ message:'messages array is required and must not be empty', type:'invalid_request_error' } });
  }
  if (!anthropic) {
    return res.status(503).json({ error:{ message:'ANTHROPIC_API_KEY not configured on this server.', type:'service_error' } });
  }

  const start = Date.now();
  const sysPrompt = system ||
    messages.find(m => m.role === 'system')?.content ||
    'You are NexGen, a helpful AI assistant built by Corverxis Technologies.';
  const chatMsgs  = messages.filter(m => m.role !== 'system');
  const requestId = `chatcmpl-${crypto.randomBytes(12).toString('hex')}`;

  try {
    if (stream) {
      // ── Streaming response (SSE) ──────────────────────────────────────────
      res.setHeader('Content-Type',  'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection',    'keep-alive');

      const streamResp = anthropic.messages.stream({
        model:      'claude-sonnet-4-6',
        max_tokens,
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
      });

    } else {
      // ── Non-streaming response ────────────────────────────────────────────
      const msg = await anthropic.messages.create({
        model:      'claude-sonnet-4-6',
        max_tokens,
        system:     sysPrompt,
        messages:   chatMsgs,
      });

      const latencyMs    = Date.now() - start;
      const inputTokens  = msg.usage?.input_tokens  || 0;
      const outputTokens = msg.usage?.output_tokens || 0;
      const content      = msg.content[0]?.text || '';

      await logTrace('chat.completions', { messages, model }, { content },
        model, latencyMs, inputTokens + outputTokens);

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

// ── POST /v1/embeddings — text embeddings ────────────────────────────────────
app.post('/v1/embeddings', requireApiKey, async (req, res) => {
  const { input, model='text-embedding-3-small' } = req.body;
  if (!input) return res.status(422).json({ error:{ message:'input is required', type:'invalid_request_error' } });

  if (!process.env.OPENAI_API_KEY) {
    return res.status(503).json({
      error:{ message:'Embeddings require OPENAI_API_KEY to be set on this server.', type:'service_error' }
    });
  }

  const start = Date.now();
  try {
    const oai    = getOpenAI();
    const texts  = Array.isArray(input) ? input : [input];
    const resp   = await oai.embeddings.create({ model:'text-embedding-3-small', input:texts });
    const latencyMs = Date.now() - start;
    await logTrace('embeddings', { input, model }, { count:resp.data.length }, model, latencyMs,
      resp.usage?.total_tokens || 0);
    res.json({
      object: 'list',
      data:   resp.data.map((d, i) => ({ object:'embedding', index:i, embedding:d.embedding })),
      model:  'nexgen-embeddings-v1',
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
    embeddings:   !!process.env.OPENAI_API_KEY,
    provider:     'Corverxis Technologies',
    uptime:       process.uptime(),
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// END NEXGEN LLM REST API
// ─────────────────────────────────────────────────────────────────────────────

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
app.use(express.static(path.join(__dirname, 'static')));
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
    console.log(`Anthropic: ${process.env.ANTHROPIC_API_KEY?'✓':'✗'}  OpenAI: ${process.env.OPENAI_API_KEY?'✓':'✗'}  Langfuse: ${process.env.LANGFUSE_SECRET_KEY?'✓':'✗'}  MLflow: ${process.env.MLFLOW_TRACKING_URI?'✓':'✗'}  Vertex: ${process.env.GCP_PROJECT?'✓':'✗'}`);
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
