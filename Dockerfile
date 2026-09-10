
FROM pytorch/pytorch:2.4.0-cuda12.1-cudnn9-runtime

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY handler.py .

<<<<<<< HEAD
CMD ["python3", "-u", "handler.py"]
=======
CMD ["python3", "-u", "handler.py"]
>>>>>>> aaf69769d040a9921064be9f53cc042501620412
