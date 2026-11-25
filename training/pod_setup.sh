#!/usr/bin/env bash
# Re-install Python packages on a fresh/restarted RunPod pod (container disk is wiped, /workspace is not).
set -e
cd /workspace/Nexgen_Lab && git pull -q
cd training
pip install -q -r requirements.txt --ignore-installed blinker
pip install -q -U torchvision
pip uninstall -y torchaudio || true
pip install -q bitsandbytes pillow fastapi "uvicorn[standard]"
echo SETUP_DONE
