# Build context = repo root:  docker build -f pro-runpod/Dockerfile .
FROM pytorch/pytorch:2.8.0-cuda12.9-cudnn9-runtime
WORKDIR /app
ENV PYTHONUNBUFFERED=1 HF_HOME=/runpod-volume/hf
RUN pip install --no-cache-dir runpod "transformers>=5.8.0" "peft>=0.11.0" accelerate pillow bitsandbytes huggingface_hub \
 && (pip uninstall -y torchaudio || true)
COPY pro-hf-deploy/handler.py /app/pro_handler.py
COPY pro-runpod/runpod_handler.py /app/runpod_handler.py
CMD ["python3", "-u", "/app/runpod_handler.py"]
