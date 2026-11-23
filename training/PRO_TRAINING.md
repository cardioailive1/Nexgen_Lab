# Training NexGen Pro (Qwen3.8-27B + QLoRA)

> **Lab Pro jobs are vision jobs** (captioned images from the Vision Data tab).
> They run `train_vision_lora.py` (same folder), not `train_lora.py`. Every
> command below works the same with `train_vision_lora.py`; for vision the
> dataset is `dataset.zip` (train.jsonl + images/), unzipped in `training/`.
> The Lab bootstrap command does clone, unzip, preview and train for you.
> Before provisioning, click **Regenerate** on the job if the Lab shows
> "Dataset export is out of date".

Pro is a LoRA fine-tune of `Qwen/Qwen3.8-27B`, not a pretrain. One 80 GB GPU
(A100/H100) is enough with 4-bit QLoRA.

## 0. What was verified and what was not
- Vision script: loss-mask logic tested with a stub processor only; the real
  Qwen3.8 processor (image tokens) has not been run. `--preview` on the pod
  checks this: TRAINED ON must show only the caption.
- Verified on CPU with a tiny model: `--data`, assistant-only loss masking,
  `--preview`, `--max-steps`, adapter save, module inspector.
- NOT verified: loading the real 27B weights, the LoRA regex against the real
  layer names, GPU memory. Steps 3 and 4 below exist to catch this cheaply.

## 1. Data readiness (do before renting a GPU)
- `sample_data/train_example.jsonl` (98 records, mostly drafts) is a format
  example, not a training set. Train on a Frontier Lab **Job snapshot** built
  from reviewed/approved records only.
- Rough floor for a visible behavior change: a few hundred to a few thousand
  clean records per domain you care about. Fewer than ~500 total: expect
  style transfer only.
- Clinical, safety, finance and mining records need expert review before use.
- Hold out 5-10% as the eval file (`--eval-data`).

## 2. Start the pod
Lab: create the Job (tier = pro) -> Provision GPU (RunPod, 80 GB). The pod
idles (`sleep infinity`); open its terminal and run the `bootstrap_command`
the Lab returns. It now clones this repo, downloads `train.jsonl`, installs
requirements, runs `--preview`, then trains.

Manual equivalent:
```bash
git clone https://github.com/cardioailive1/Nexgen_Lab.git && cd Nexgen_Lab/training
pip install -r requirements.txt
curl -L "<dataset export URL from the Job>" -o train.jsonl
```

### 2b. Spot-check the vision data (5-10 minutes)
```bash
python spot_check.py --data train.jsonl --per-domain 5 --min-per-domain 3
```
Prints automatic flags over the whole dataset (missing/duplicate images,
empty/short captions, refusal-style text) and writes `spot_check.html` (open
it, review the image + caption cards) and `spot_check.csv` (fill `verdict`).
Small domains (e.g. cardiovascular_disease, 47 images) are always sampled.
If more than ~5% of the sample is wrong, or any automatic flag is large,
pause and send those records back to Vision Review before training.

### 2c. No Lab? Export straight from the database
If the Lab is down, run `python export_from_db.py --out .` (needs `DATABASE_URL`
for the database that holds the data, plus the `S3_*` variables). It writes the
same `train.jsonl` + `images/` the Lab export would. Add `--limit 50` to test.

## 3. Check the base model and LoRA targets (no weights downloaded)
```bash
python inspect_modules.py Qwen/Qwen3.8-27B
```
Make sure the `q_proj/k_proj/...` suffixes exist inside the language model. If
the hybrid layers use other names (e.g. `in_proj_*`), add them to
`lora_target_regex` in `config_pro.yaml`.

## 4. Preview, then smoke test
```bash
python train_lora.py --config config_pro.yaml --data train.jsonl --preview
python train_lora.py --config config_pro.yaml --data train.jsonl --max-steps 5 --output-dir checkpoints/smoke
```
Preview must show only assistant replies under `TRAINED ON` (typically
20-40% of tokens). Smoke test must finish 5 steps without OOM; if it OOMs,
lower `max_seq_len` to 2048.

## 5. Full run
```bash
python train_lora.py --config config_pro.yaml --data train.jsonl --eval-data eval.jsonl
```
Watch `eval_loss`: if it rises while train loss falls, stop and use an
earlier checkpoint (or 1-2 epochs). Metrics go to DagsHub/MLflow if logged in.

## 6. Evaluate before shipping
Compare base vs adapter on the held-out file and ~20 hand-written prompts per
domain; have a domain expert grade clinical/safety/finance answers.

## 7. Serve
`training/serve.py` or `pro-hf-deploy/` (vLLM recommended for 27B). Merge or
load the adapter from `checkpoints/nexgen-pro-v1`, then point the product at
the endpoint (`NEXGEN_PRO_INFERENCE_URL`).
