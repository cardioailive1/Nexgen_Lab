# NexGen Pro — Hugging Face Inference Endpoints Deployment

Base model: `Qwen/Qwen3.8-27B` — text + vision, Apache 2.0.

## Why this deploys differently than Flash did

Flash needed transformers' unreleased git-main branch (`qwen3_5` architecture
wasn't in any stable release yet), which caused most of the RunPod/HF
troubleshooting that night — CUDA mismatches, torchaudio conflicts, disk
space, the works.

Pro doesn't have that problem. Qwen3.8-27B's architecture support landed in
**transformers 5.8.0**, a genuine stable PyPI release — not a dev branch.
`pip install transformers>=5.8.0` just works, no `git+github.com` install
required.

## Try this first — it may just work with zero custom code

1. Go to `https://huggingface.co/Qwen/Qwen3.8-27B` (or your own fine-tuned
   Pro checkpoint's repo, once trained)
2. Click **Deploy → Inference Endpoints**
3. Pick a GPU — Qwen3.8-27B needs roughly **56GB VRAM at BF16** (a single
   A100 80GB or similar single-GPU tier is enough; no multi-GPU cluster
   needed)
4. Deploy

Because this is a standard, well-supported architecture, HF's own default
container may correctly auto-detect and serve it without any custom handler
at all.

## If the default deploy fails, or you want a custom handler for consistency

Use `handler.py` and `requirements.txt` in this folder — same pattern used
successfully for Flash's RunPod deployment, adapted here for HF's
`EndpointHandler` interface:

1. Go to your model repo's **Files and versions** tab
2. Add `handler.py` and `requirements.txt` from this folder at the repo root
3. When creating the endpoint, the **Task** should detect as **Custom**
   automatically once these files are present

## What NOT to copy over from Flash's setup

Flash's `handler.py` included two workarounds specific to its bleeding-edge
dependency situation — **don't carry these over to Pro, they're not needed
and add unnecessary risk**:

- The `torchaudio` stub (`sys.modules['torchaudio'] = ...`) — Flash needed
  this because a CUDA-mismatched torchaudio got pulled in as a side effect
  of the git-main transformers install. Pro's stable transformers install
  doesn't have this issue.
- Any exact `torch==X.Y.Z --index-url .../cu121` pin — Pro's `torch>=2.5`
  is a normal, flexible constraint; no CUDA-version pinning battle expected.

## Wiring this into the Lab once deployed

Set on your Render backend:
```
NEXGEN_PRO_INFERENCE_URL=https://your-endpoint-url.endpoints.huggingface.cloud
```

HF Inference Endpoints speak the direct `{url}/v1/chat/completions` protocol
already — no RunPod-style request wrapping/polling needed. The Lab's
`callInferenceUrl()` helper already handles this correctly for any
non-RunPod URL.

## Before going live

Same staged approach used for Flash — test thoroughly through the Lab's
**Test Chat** and **Model Comparison** tools first. Never point
`NEXGEN_PRO_INFERENCE_URL` at a checkpoint until it's been verified working
end to end.
