# NDIF OpenAI Adapter

Standalone compatibility bridge for NNsight/NDIF, configured for `Qwen/Qwen3.8-27B`.

## Endpoints

- `POST /v1/chat/completions` — nonstreaming or live SSE token streaming (`stream: true`)
- `POST /v1/responses` — partial nonstreaming Responses API
- `GET /v1/models` — configured allowlist, NOT guaranteed NDIF availability
- `POST /v1/requests/{id}/cancel` — stop gateway stream (the request ID is in `X-NDIF-Request-ID`)
- `GET /health`

## Configuration on Railway

Railway project: `ndif-openai-adapter`; service: `ndif-openai-gateway`.
Code: branch `ndif-openai-adapter` in `anasalsawy/browser-use-bridge`, root `/ndif-openai-adapter`.

Set:

- `NDIF_API_KEY` — NDIF credential (required).
- `GATEWAY_API_KEY` — secret used as OpenAI-style bearer token (required).
- `NDIF_HOST=https://api.ndif.us`
- `NDIF_MODELS=Qwen/Qwen3.8-27B`

Base URL: `https://ndif-openai-gateway-production.up.railway.app/v1`.

## Streaming details

NDIF's public NNsight documentation describes using `nnsight.local()` to stream data during remote execution. This gateway uses the per-token generator streamer output in a local traced callback and sends OpenAI SSE content chunks **during** remote generation. This implementation has not been exercised against NDIF because live tests were explicitly declined; **do not claim it works until a real NDIF generation confirms it**. Tool-call streaming buffers the tool-call text until a full JSON call can be parsed, rather than leaking unfinished tool markup.

## Tool calling

The gateway passes structured function tools to the model tokenizer's `apply_chat_template(..., tools=...)` and parses native `<tool_call>` JSON blocks. It rejects unknown functions, malformed arguments and arguments invalid under the provided JSON schema. It honors `tool_choice=none`, `auto`, `required`, and named function selection as constraints; named and required choices are **not guaranteed to be obeyed by the model** and fail explicitly when violated. Not a native NDIF API for tool execution. Your host must execute functions.

## Stopping requests

If the client disconnects or calls `/v1/requests/{id}/cancel`, the gateway stops forwarding chunks, sets a local cancellation flag and closes the NDIF backend subscription **if the backend exposes a close method**. This **does not guarantee cancellation of the GPU job or NDIF billing**, and a synchronous NNsight remote job may continue on the server. NDIF's published API does not document a reliable kill-job endpoint for this path.

## Known limitations

Qwen3.8 deployment on NDIF has not been verified. Responses API is partial; no persistent KV session; no multimodal inputs. The current implementation is an unverified candidate, not production-ready. Avoid connecting it to production Cursor/Persona without a live check.

No live tests were performed at user's request.
