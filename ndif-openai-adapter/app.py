"""OpenAI-compatible gateway — proxies to sawii/sync.

Cursor (and any OpenAI client) sends /v1/chat/completions with model=gpt-4o.
This adapter accepts that, forwards the conversation to the sawii-sync
5-lobe runtime at SYNC_URL, and returns a standard OpenAI response object.

No NDIF/nnsight code here — sync owns the model. This is a pure HTTP shim.
"""
import hmac, json, os, time, uuid
from typing import Any

import httpx
from fastapi import FastAPI, Depends, Header, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from tooling import prepared_messages, choose_functions, render_prompt, parse_calls

app = FastAPI(title="Sawii Sync OpenAI Adapter", version="0.2.0")

# ── config ────────────────────────────────────────────────────────────────────

def _gateway_key():
    k = os.getenv("GATEWAY_API_KEY", "").strip()
    if not k:
        raise RuntimeError("Set GATEWAY_API_KEY")
    return k

def _sync_url():
    url = os.getenv("SYNC_URL", "").strip().rstrip("/")
    if not url:
        raise RuntimeError("Set SYNC_URL to the sawii-sync service URL")
    return url

def _models_allowed():
    return [m.strip() for m in os.getenv("NDIF_MODELS", "gpt-4o").split(",") if m.strip()]

@app.on_event("startup")
def check_config():
    _gateway_key()
    _sync_url()

# ── auth ──────────────────────────────────────────────────────────────────────

def auth(authorization: str | None = Header(None)):
    key = _gateway_key()
    if not authorization or not authorization.startswith("Bearer ") or \
       not hmac.compare_digest(authorization[7:], key):
        raise HTTPException(401, "Invalid gateway API key")

# ── request schema ────────────────────────────────────────────────────────────

class ChatRequest(BaseModel):
    model: str
    messages: list[dict[str, Any]] = Field(min_length=1)
    max_tokens: int | None = Field(default=None, ge=1, le=8192)
    max_completion_tokens: int | None = Field(default=None, ge=1, le=8192)
    temperature: float | None = Field(default=None, ge=0, le=2)
    top_p: float | None = Field(default=None, gt=0, le=1)
    stream: bool = False
    tools: list[dict[str, Any]] | None = None
    tool_choice: Any = None

# ── sync proxy ────────────────────────────────────────────────────────────────

def _messages_to_sync_text(messages: list[dict]) -> str:
    """
    Flatten OpenAI messages into a single string for sync's /v1/chat endpoint.
    system + prior turns are prepended as plain context; last user message is
    the live input. sync has no system-prompt slot — everything is raw input.
    """
    parts = []
    for m in messages:
        role = m.get("role", "")
        content = m.get("content") or ""
        if isinstance(content, list):
            # vision content blocks — extract text parts only
            content = " ".join(c.get("text", "") for c in content if isinstance(c, dict))
        if role == "system":
            parts.append(content)
        elif role == "user":
            parts.append(content)
        elif role == "assistant":
            parts.append(content)
        elif role == "tool":
            parts.append(f"[tool result] {content}")
    return "\n\n".join(p for p in parts if p)


async def _call_sync(message: str, max_tokens: int) -> str:
    """POST to sawii-sync /v1/chat and return the reply text."""
    url = _sync_url() + "/v1/chat"
    payload = {"message": message, "max_tokens": max_tokens}
    async with httpx.AsyncClient(timeout=120.0) as client:
        try:
            resp = await client.post(url, json=payload)
            resp.raise_for_status()
            data = resp.json()
            return data.get("reply", "")
        except httpx.HTTPStatusError as e:
            raise HTTPException(502, f"sync returned {e.response.status_code}: {e.response.text[:300]}")
        except Exception as e:
            raise HTTPException(502, f"sync unreachable: {type(e).__name__}: {str(e)[:200]}")


async def completion(req: ChatRequest) -> dict:
    if req.model not in _models_allowed():
        raise HTTPException(404, f"Model {req.model!r} not configured. Set NDIF_MODELS.")

    funcs, choice = choose_functions(req.tools, req.tool_choice)
    messages = prepared_messages(req.messages)
    max_tokens = req.max_completion_tokens or req.max_tokens or 512

    # If tools are requested, render the full prompt with tool schemas and
    # send that as the message so the model sees the tool context.
    if funcs:
        # Build a tokenizer-free text prompt for tool-aware generation
        prompt_text = render_prompt(None, messages, funcs, choice)
    else:
        prompt_text = _messages_to_sync_text(messages)

    answer = await _call_sync(prompt_text, max_tokens)

    calls, text = parse_calls(answer, funcs, choice)
    message = {"role": "assistant", "content": text}
    if calls:
        message["tool_calls"] = calls

    return {
        "id": "chatcmpl-" + uuid.uuid4().hex,
        "object": "chat.completion",
        "created": int(time.time()),
        "model": req.model,
        "choices": [{
            "index": 0,
            "message": message,
            "finish_reason": "tool_calls" if calls else "stop",
        }],
        "usage": {
            "prompt_tokens": len(prompt_text.split()),   # rough estimate
            "completion_tokens": len(answer.split()),
            "total_tokens": len(prompt_text.split()) + len(answer.split()),
        },
    }

# ── routes ────────────────────────────────────────────────────────────────────

@app.get("/health")
def health():
    return {"status": "ok", "service": "sawii-sync-openai-adapter"}

@app.get("/v1/models", dependencies=[Depends(auth)])
def models():
    now = int(time.time())
    return {"object": "list", "data": [
        {"id": m, "object": "model", "created": now, "owned_by": "sawii"}
        for m in _models_allowed()
    ]}

@app.post("/v1/chat/completions", dependencies=[Depends(auth)])
async def chat(req: ChatRequest):
    return await completion(req)


# ── Responses API (for agents that use /v1/responses) ─────────────────────────

class ResponseRequest(BaseModel):
    model: str
    input: Any
    instructions: str | None = None
    max_output_tokens: int | None = Field(default=None, ge=1, le=8192)
    temperature: float | None = None
    stream: bool = False
    tools: list[dict[str, Any]] | None = None
    previous_response_id: str | None = None

@app.post("/v1/responses", dependencies=[Depends(auth)])
async def responses(req: ResponseRequest):
    if req.previous_response_id or req.stream:
        raise HTTPException(400, "Streaming and previous_response_id not supported")
    if isinstance(req.input, str):
        msgs = [{"role": "user", "content": req.input}]
    elif isinstance(req.input, list):
        msgs = []
        for item in req.input:
            if item.get("type") == "function_call_output":
                msgs.append({"role": "tool", "tool_call_id": item.get("call_id"),
                              "content": str(item.get("output", ""))})
            elif item.get("type") == "function_call":
                msgs.append({"role": "assistant", "content": "",
                             "tool_calls": [{"id": item.get("call_id"), "type": "function",
                                             "function": {"name": item.get("name"),
                                                          "arguments": item.get("arguments")}}]})
            elif item.get("role") in ("system", "developer", "user", "assistant"):
                msgs.append(item)
            else:
                raise HTTPException(400, "Unsupported Responses input item")
    else:
        raise HTTPException(400, "input must be a string or messages")
    if req.instructions:
        msgs.insert(0, {"role": "system", "content": req.instructions})
    tools = ([{"type": "function", "function": {k: v for k, v in t.items()
               if k in ("name", "description", "parameters")}} for t in req.tools]
             if req.tools else None)
    result = await completion(ChatRequest(
        model=req.model, messages=msgs,
        max_completion_tokens=req.max_output_tokens,
        temperature=req.temperature, tools=tools,
    ))
    msg = result["choices"][0]["message"]
    if msg.get("tool_calls"):
        output = [{"type": "function_call", "id": "fc_" + uuid.uuid4().hex,
                   "call_id": c["id"], "name": c["function"]["name"],
                   "arguments": c["function"]["arguments"], "status": "completed"}
                  for c in msg["tool_calls"]]
    else:
        output = [{"type": "message", "id": "msg_" + uuid.uuid4().hex,
                   "role": "assistant", "status": "completed",
                   "content": [{"type": "output_text", "text": msg["content"],
                                 "annotations": []}]}]
    usage = result["usage"]
    return {"id": "resp_" + uuid.uuid4().hex, "object": "response",
            "created_at": result["created"], "model": req.model,
            "status": "completed", "output": output, "error": None,
            "incomplete_details": None,
            "usage": {"input_tokens": usage["prompt_tokens"],
                      "output_tokens": usage["completion_tokens"],
                      "total_tokens": usage["total_tokens"]}}
