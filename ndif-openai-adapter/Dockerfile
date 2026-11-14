FROM python:3.11-slim
WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
COPY requirements.txt .
# Pure HTTP shim — no torch, no nnsight, no CUDA wheels.
RUN pip install --no-cache-dir -r requirements.txt
COPY app.py tooling.py ndif_smoke.py ./
EXPOSE 8000
CMD ["sh", "-c", "uvicorn app:app --host 0.0.0.0 --port ${PORT:-8000}"]
