"""OpenAI compatible gateway for NDIF NNsight remote generation."""
import asyncio, hmac, json, os, re, time, uuid
from functools import lru_cache
from typing import Any
from fastapi import FastAPI, Depends, Header, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

app = FastAPI(title="NDIF OpenAI Adapter", version="0.1.0")

def config():
    ndif = os.getenv("NDIF_API_KEY", "").strip()
    gateway = os.getenv("GATEWAY_API_KEY", "").strip()
    if not ndif or not gateway:
        raise RuntimeError("Set NDIF_API_KEY and GATEWAY_API_KEY")
    return ndif, gateway

@app.on_event("startup")
def check_config():
    config()

def auth(authorization: str | None = Header(None)):
    key = config()[1]
    if not authorization or not authorization.startswith("Bearer ") or not hmac.compare_digest(authorization[7:], key):
        raise HTTPException(401, "Invalid gateway API key")

def models_allowed():
    return [m.strip() for m in os.getenv("NDIF_MODELS", "Qwen/Qwen3.8-27B").split(",") if m.strip()]

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

def normalize_messages(messages):
    result = []
    for msg in messages:
        role = msg.get("role")
        if role not in ("system", "developer", "user", "assistant", "tool"):
            raise HTTPException(400, "Unsupported role")
        content = msg.get("content") or ""
        if isinstance(content, list):
            if any(isinstance(p, dict) and p.get("type") != "text" for p in content):
                raise HTTPException(400, "Only text content is supported")
            content = "\n".join(p.get("text", "") for p in content if isinstance(p, dict))
        if not isinstance(content, str):
            raise HTTPException(400, "Only text content is supported")
        if msg.get("tool_calls"):
            content += "\nPreviously emitted tool calls: " + json.dumps(msg["tool_calls"], ensure_ascii=False)
        if role == "tool":
            content = "Tool result" + (" (" + msg["tool_call_id"] + ")" if msg.get("tool_call_id") else "") + ": " + content
            role = "user"
        elif role == "developer":
            role = "system"
        result.append({"role": role, "content": content})
    return result

def tool_system_prompt(tools):
    funs = [x.get("function", {}) for x in tools if x.get("type") == "function"]
    if not funs:
        raise HTTPException(400, "Only function tools are supported")
    return ('You have the following functions. To call functions, output ONLY a JSON object: '
            '{"tool_calls":[{"name":"function_name","arguments":{}}]}. '
            'Otherwise respond normally. Functions: ' + json.dumps(funs, ensure_ascii=False))

def parse_calls(answer, tools):
    if not tools:
        return None
    s = answer.strip()
    if s.startswith("```"):
        s = re.sub(r"^```(?:json)?\s*|\s*```$", "", s)
    try:
        payload = json.loads(s)
    except (ValueError, TypeError):
        return None
    if not isinstance(payload, dict) or not isinstance(payload.get("tool_calls"), list):
        return None
    allowed = {t.get("function", {}).get("name") for t in tools if t.get("type") == "function"}
    result = []
    for c in payload["tool_calls"]:
        if not isinstance(c, dict) or c.get("name") not in allowed or not isinstance(c.get("arguments"), dict):
            return None
        result.append({"id": "call_" + uuid.uuid4().hex[:24], "type": "function",
                       "function": {"name": c["name"], "arguments": json.dumps(c["arguments"], ensure_ascii=False)}})
    return result or None

@lru_cache(maxsize=8)
def load_model(model_id):
    from nnsight import TransformersModel
    return TransformersModel(model_id, task="text-generation")

def generate(model_id, messages, max_tokens, temperature, top_p):
    from nnsight import CONFIG
    CONFIG.API.HOST = os.getenv("NDIF_HOST", "https://api.ndif.us")
    CONFIG.API.APIKEY = config()[0]
    CONFIG.APP.REMOTE_LOGGING = False
    model = load_model(model_id)
    tokenizer = model.tokenizer
    if getattr(tokenizer, "chat_template", None):
        prompt = tokenizer.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
    else:
        prompt = "\n".join(x["role"].upper() + ": " + x["content"] for x in messages) + "\nASSISTANT:"
    prompt_ids = tokenizer.encode(prompt, add_special_tokens=False)
    opts = {"max_new_tokens": max_tokens, "do_sample": temperature is not None and temperature > 0}
    if opts["do_sample"]:
        opts["temperature"] = temperature
        if top_p is not None:
            opts["top_p"] = top_p
    with model.generate(prompt, remote=True, **opts) as tracer:
        tokens = tracer.result.save()
    ids = tokens[0].tolist() if hasattr(tokens[0], "tolist") else list(tokens[0])
    completion = ids[len(prompt_ids):]
    if not completion:
        raise RuntimeError("NDIF returned no completion or incompatible sequence")
    return tokenizer.decode(completion, skip_special_tokens=True), len(prompt_ids), len(completion)

async def completion(req):
    if req.model not in models_allowed():
        raise HTTPException(404, "Unknown configured model")
    messages = normalize_messages(req.messages)
    if req.tools and req.tool_choice != "none":
        messages.insert(0, {"role": "system", "content": tool_system_prompt(req.tools)})
    limit = req.max_completion_tokens or req.max_tokens or 512
    try:
        answer, in_tokens, out_tokens = await asyncio.to_thread(generate, req.model, messages, limit, req.temperature, req.top_p)
    except Exception as exc:
        raise HTTPException(502, {"error": {"message": "NDIF generation failed; inspect server logs and model availability",
                                           "type": "upstream_error", "exception": type(exc).__name__}}) from exc
    calls = parse_calls(answer, req.tools if req.tool_choice != "none" else None)
    message = {"role": "assistant", "content": None if calls else answer}
    if calls:
        message["tool_calls"] = calls
    return {"id": "chatcmpl-" + uuid.uuid4().hex, "object": "chat.completion", "created": int(time.time()),
            "model": req.model,
            "choices": [{"index": 0, "message": message, "finish_reason": "tool_calls" if calls else ("length" if out_tokens >= limit else "stop")}],
            "usage": {"prompt_tokens": in_tokens, "completion_tokens": out_tokens, "total_tokens": in_tokens + out_tokens}}

def sse(result):
    base = {k: result[k] for k in ("id", "model", "created")}
    base["object"] = "chat.completion.chunk"
    choice = result["choices"][0]
    for delta, reason in (({"role": "assistant"}, None),
                          ({"tool_calls": [{"index": i, **c} for i, c in enumerate(choice["message"]["tool_calls"])]}
                           if choice["message"].get("tool_calls") else {"content": choice["message"]["content"]}, None),
                          ({}, choice["finish_reason"])):
        yield "data: " + json.dumps({**base, "choices": [{"index": 0, "delta": delta, "finish_reason": reason}]}) + "\n\n"
    yield "data: [DONE]\n\n"

@app.get("/health")
def health():
    return {"status": "ok", "service": "ndif-openai-adapter"}

@app.get("/v1/models", dependencies=[Depends(auth)])
def models():
    now = int(time.time())
    return {"object": "list", "data": [{"id": m, "object": "model", "created": now, "owned_by": "ndif"} for m in models_allowed()]}

@app.post("/v1/chat/completions", dependencies=[Depends(auth)])
async def chat(req: ChatRequest):
    result = await completion(req)
    if req.stream:
        return StreamingResponse(sse(result), media_type="text/event-stream",
                                 headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})
    return result

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
        raise HTTPException(400, "Streaming and previous_response_id are not supported by this Responses bridge")
    if isinstance(req.input, str):
        msgs = [{"role": "user", "content": req.input}]
    elif isinstance(req.input, list):
        msgs = []
        for item in req.input:
            if item.get("type") == "function_call_output":
                msgs.append({"role": "tool", "tool_call_id": item.get("call_id"), "content": str(item.get("output", ""))})
            elif item.get("type") == "function_call":
                msgs.append({"role": "assistant", "content": "", "tool_calls": [
                    {"id": item.get("call_id"), "type": "function",
                     "function": {"name": item.get("name"), "arguments": item.get("arguments")}}]})
            elif item.get("role") in ("system", "developer", "user", "assistant"):
                msgs.append(item)
            else:
                raise HTTPException(400, "Unsupported Responses input item")
    else:
        raise HTTPException(400, "input must be a string or messages")
    if req.instructions:
        msgs.insert(0, {"role": "system", "content": req.instructions})
    tools = ([{"type": "function", "function": {k:v for k,v in t.items()
              if k in ("name", "description", "parameters")}} for t in req.tools] if req.tools else None)
    result = await completion(ChatRequest(model=req.model, messages=msgs, max_completion_tokens=req.max_output_tokens,
                                          temperature=req.temperature, tools=tools))
    msg = result["choices"][0]["message"]
    if msg.get("tool_calls"):
        output = [{"type": "function_call", "id": "fc_" + uuid.uuid4().hex, "call_id": c["id"],
                   "name": c["function"]["name"], "arguments": c["function"]["arguments"], "status": "completed"}
                  for c in msg["tool_calls"]]
    else:
        output = [{"type": "message", "id": "msg_" + uuid.uuid4().hex, "role": "assistant", "status": "completed",
                   "content": [{"type": "output_text", "text": msg["content"], "annotations": []}]}]
    usage = result["usage"]
    return {"id": "resp_" + uuid.uuid4().hex, "object": "response", "created_at": result["created"],
            "model": req.model, "status": "completed", "output": output, "error": None,
            "incomplete_details": None, "usage": {"input_tokens": usage["prompt_tokens"],
            "output_tokens": usage["completion_tokens"], "total_tokens": usage["total_tokens"]}}
