#!/usr/bin/env python3
"""Upload the MERGED NexGen Pro model (~51 GB) to a PRIVATE Hugging Face repo, one file at a time.

    read -s -p "HF write token: " HF_TOKEN; export HF_TOKEN     # its own step; type it, never paste in chat
    python upload_merged_to_hf.py [--src DIR] [--repo USER/NAME]
    unset HF_TOKEN                                              # then delete the token on huggingface.co

Resumable: files already in the repo with the same size are skipped, so just re-run if it stops.
"""
import argparse, os
from huggingface_hub import HfApi

ap = argparse.ArgumentParser()
ap.add_argument("--src", default="/workspace/merged/nexgen-pro-v1")
ap.add_argument("--repo", default="")
a = ap.parse_args()

token = os.environ.get("HF_TOKEN")
if not token:
    raise SystemExit('Set HF_TOKEN first: read -s -p "HF write token: " HF_TOKEN; export HF_TOKEN')
api = HfApi(token=token)
repo = a.repo or f"{api.whoami()['name']}/nexgen-pro-v1-merged"
api.create_repo(repo, private=True, exist_ok=True)
print("repo:", repo, "(private)", flush=True)

have = {}
try:
    for f in api.list_repo_tree(repo, recursive=True):
        if hasattr(f, "size"):
            have[f.path] = f.size
except Exception:
    pass

README = f"""---
base_model: Qwen/Qwen3.8-27B
pipeline_tag: image-text-to-text
---
# NexGen Pro v1 (merged)
`Qwen/Qwen3.8-27B` with the NexGen Pro v1 LoRA adapter merged in (bf16). Private, internal use.

Serve with vLLM >= 0.17 and transformers >= 5.8, thinking off:
`vllm serve {repo} --default-chat-template-kwargs '{{"enable_thinking": false}}'`

Prompt format: system `You are an expert assistant specializing in the {{domain}} domain.`; user = image + `Describe what is shown in this image.`
Adapter-only version: nexgen2/nexgen-pro-v1-lora
"""
api.upload_file(path_or_fileobj=README.encode(), path_in_repo="README.md", repo_id=repo)

files = sorted(f for f in os.listdir(a.src) if os.path.isfile(os.path.join(a.src, f)))
for i, f in enumerate(files, 1):
    p = os.path.join(a.src, f)
    if have.get(f) == os.path.getsize(p):
        print(f"[{i}/{len(files)}] skip {f} (already uploaded)", flush=True)
        continue
    print(f"[{i}/{len(files)}] uploading {f} ({os.path.getsize(p)/1e9:.2f} GB)...", flush=True)
    api.upload_file(path_or_fileobj=p, path_in_repo=f, repo_id=repo)
print("UPLOAD DONE ->", repo, "\nNow: unset HF_TOKEN, and delete the token on huggingface.co", flush=True)
