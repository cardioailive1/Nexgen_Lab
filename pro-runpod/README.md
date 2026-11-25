# NexGen Pro on RunPod Serverless

Why not HF Inference Endpoints' default toolkit: its container imports `transformers.file_utils.is_tf_available`,
which was removed in transformers 5.x, and Qwen3.8 needs >= 5.8, so the toolkit crashes before our handler loads
(exit code 3). Here we control the container.

1. Make a READ-only HF token scoped to `nexgen2/nexgen-pro-v1-lora` (fine-grained).
2. RunPod -> Serverless -> New Endpoint -> import from GitHub: repo `cardioailive1/Nexgen_Lab`, branch
   `fix-pro-lora-targets`, Dockerfile path `pro-runpod/Dockerfile`, build context = repo root.
3. GPU: 80 GB (A100/H100 80GB). Container disk >= 90 GB (or attach a network volume and keep HF_HOME=/runpod-volume/hf).
4. Env: HF_TOKEN (secret), optionally LOAD_4BIT=1. Workers: min 0, max 1. Execution timeout >= 900 s.
5. Test: POST {endpoint}/runsync with {"input": {"system": "...", "messages": [...], "max_tokens": 500}}, header
   `Authorization: Bearer <RUNPOD_API_KEY>`. Images go in messages[].content as
   {"type":"image_url","image_url":{"url":"data:image/jpeg;base64,..."}}.
6. Lab: NEXGEN_PRO_INFERENCE_URL = https://api.runpod.ai/v2/<endpoint id>  (+ RUNPOD_API_KEY already set on Render).
