#!/usr/bin/env python3
"""Back up everything worth keeping from the pod's /workspace to PRIVATE Hugging Face repos.

    export HF_TOKEN=...   (Write token; type it at a hidden prompt, never paste it in chat)
    python backup_to_hf.py            # adapters + data files + logs
    python backup_to_hf.py --images   # also the 8,039 training images (~1.9 GB)

Goes to (created private if missing, under the token's own account):
  <user>/nexgen-pro-v1-lora   extra adapter checkpoints under checkpoints/ (final adapter is already at the root)
  <user>/nexgen-pro-data      dataset repo: train/eval jsonl, eval results, logs/, (images/ with --images)

Deliberately NOT uploaded: hf/ (the 52 GB base model, re-downloadable from Qwen's Hub page), optimizer/scheduler
state, smoke-test checkpoints, and the code (already on GitHub). Log files are scanned first and skipped if they
look like they contain a secret.
"""
import argparse, os, re
from huggingface_hub import HfApi

W = "/workspace"
T = f"{W}/Nexgen_Lab/training"
CK = f"{T}/checkpoints/nexgen-pro-v1"
SECRET = re.compile(
    r"hf_[A-Za-z0-9]{20,}|postgres(?:ql)?://[^\s:@/]+:[^\s@]+@|AKIA[0-9A-Z]{16}"
    r"|\b[0-9a-f]{40}\b|(?i:password|secret|token|api[_-]?key)\s*[=:]\s*['\"]?[A-Za-z0-9/+_-]{12,}")


def has_secret(path):
    try:
        with open(path, "r", errors="ignore") as f:
            for line in f:
                if SECRET.search(line):
                    return True
    except OSError:
        return True
    return False


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--images", action="store_true", help="also upload training images")
    a = ap.parse_args()
    token = os.environ.get("HF_TOKEN")
    if not token:
        raise SystemExit("Set HF_TOKEN first (read -s -p 'HF write token: ' HF_TOKEN; export HF_TOKEN).")
    api = HfApi(token=token)
    user = api.whoami()["name"]
    model_repo, data_repo = f"{user}/nexgen-pro-v1-lora", f"{user}/nexgen-pro-data"
    api.create_repo(model_repo, private=True, exist_ok=True)
    api.create_repo(data_repo, repo_type="dataset", private=True, exist_ok=True)
    print("repos:", model_repo, data_repo, flush=True)

    # 1. adapter-only checkpoints (no optimizer state)
    ckpts = {"checkpoint-400": f"{W}/keep/checkpoint-400",
             "checkpoint-800": f"{CK}/checkpoint-800",
             "checkpoint-900": f"{CK}/checkpoint-900"}
    for name, path in ckpts.items():
        if os.path.isdir(path):
            api.upload_folder(repo_id=model_repo, folder_path=path, path_in_repo=f"checkpoints/{name}",
                              allow_patterns=["adapter_*", "*.json"], ignore_patterns=["trainer_state*", "optimizer*"])
            print("uploaded", name, flush=True)
        else:
            print("missing", path, flush=True)

    # 2. data + eval results
    for f in ("train.jsonl", "train_split.jsonl", "eval.jsonl", "eval_results.html", "eval_results.jsonl",
              "eval_results2.html", "eval_results2.jsonl"):
        p = f"{T}/{f}"
        if os.path.exists(p):
            api.upload_file(path_or_fileobj=p, path_in_repo=f, repo_id=data_repo, repo_type="dataset")
            print("uploaded", f, flush=True)

    # 3. logs (secret-scanned)
    for f in ("train.log", "eval.log", "eval2.log", "smoke3.log", "hf_download.log", "demo.log"):
        p = f"{W}/{f}"
        if not os.path.exists(p):
            continue
        if has_secret(p):
            print("SKIPPED (looks like it contains a secret):", f, flush=True)
            continue
        api.upload_file(path_or_fileobj=p, path_in_repo=f"logs/{f}", repo_id=data_repo, repo_type="dataset")
        print("uploaded logs/" + f, flush=True)

    # 4. images (optional, resumable)
    if a.images and os.path.isdir(f"{T}/images"):
        print("uploading images (this takes a while)...", flush=True)
        api.upload_large_folder(repo_id=data_repo, repo_type="dataset", folder_path=T, allow_patterns=["images/*"])
        print("uploaded images", flush=True)

    print("BACKUP DONE. Now delete the token and run: unset HF_TOKEN", flush=True)


if __name__ == "__main__":
    main()
