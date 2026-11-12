# NDIF OpenAI Adapter

OpenAI-shaped compatibility gateway for NDIF NNsight remote text generation.

## Routes
- GET /health
- GET /v1/models
- POST /v1/chat/completions
- POST /v1/responses (partial)

Railway deployment: use branch `ndif-openai-adapter` of `anasalsawy/browser-use-bridge`, with **root directory `/ndif-openai-adapter`** and Dockerfile there.

Set secrets NDIF_API_KEY and GATEWAY_API_KEY in Railway, and NDIF_MODELS=Qwen/Qwen3.8-27B. Base URL after deployment: https://YOUR_DOMAIN/v1

NDIF hosting of Qwen/Qwen3.8-27B is **unverified**. Streaming is buffered, tool calls are best-effort JSON prompting, Responses API is partial. Do not expect full OpenAI feature parity.
