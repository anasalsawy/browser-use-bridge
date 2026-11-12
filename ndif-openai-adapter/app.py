"""OpenAI compatible gateway for NDIF NNsight remote generation."""
import asyncio, hmac, json, os, re, time, uuid
from functools import lru_cache
from typing import Any
from fastapi import FastAPI, Depends, Header, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from tooling import prepared_messages, choose_functions, render_prompt, parse_calls
# NNsight installs object.save() globally. AnyIO's TypedAttributeSet rejects
# that injected method if its asyncio backend is imported afterward.
# Load the backend before importing NNsight through streaming.py.
import anyio._backends._asyncio
from streaming import begin, cancel, forget, SESSIONS, SESSIONS_LOCK

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



@lru_cache(maxsize=8)
def load_model(model_id):
    from nnsight import TransformersModel
    return TransformersModel(model_id, task="text-generation")


def prepare(req):
    if req.model not in models_allowed():
        raise HTTPException(404, "Unknown configured model")
    model = load_model(req.model)
    funcs, choice = choose_functions(req.tools, req.tool_choice)
    messages = prepared_messages(req.messages)
    prompt = render_prompt(model.tokenizer, messages, funcs, choice)
    token_ids = model.tokenizer.encode(prompt, add_special_tokens=False)
    limit = req.max_completion_tokens or req.max_tokens or 512
    options = {"max_new_tokens": limit, "do_sample": req.temperature is not None and req.temperature > 0}
    if options["do_sample"]:
        options["temperature"] = req.temperature
        if req.top_p is not None:
            options["top_p"] = req.top_p
    return model, prompt, token_ids, options, funcs, choice


def generate(model, prompt, prompt_ids, options):
    from nnsight import CONFIG
    CONFIG.API.HOST = os.getenv("NDIF_HOST", "https://api.ndif.us")
    CONFIG.API.APIKEY = config()[0]
    CONFIG.APP.REMOTE_LOGGING = False
    with model.generate(prompt, remote=True, **options) as tracer:
        tokens = tracer.result.save()
    ids = tokens[0].tolist() if hasattr(tokens[0], "tolist") else list(tokens[0])
    if ids[:len(prompt_ids)] != prompt_ids:
        raise RuntimeError("NDIF generation prompt tokens do not match input")
    completion_ids = ids[len(prompt_ids):]
    return model.tokenizer.decode(completion_ids, skip_special_tokens=True), len(prompt_ids), len(completion_ids)



async def completion(req):
    model, prompt, prompt_ids, options, funcs, choice = prepare(req)
    try:
        answer, in_tokens, out_tokens = await asyncio.to_thread(generate, model, prompt, prompt_ids, options)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(502, {"error": {"message": "NDIF generation failed; inspect server logs",
                                           "type": "upstream_error", "exception": type(exc).__name__}}) from exc
    calls, text = parse_calls(answer, funcs, choice)
    message = {"role": "assistant", "content": text}
    if calls:
        message["tool_calls"] = calls
    return {"id": "chatcmpl-" + uuid.uuid4().hex, "object": "chat.completion", "created": int(time.time()),
            "model": req.model,
            "choices": [{"index": 0, "message": message,
                         "finish_reason": "tool_calls" if calls else ("length" if out_tokens >= options["max_new_tokens"] else "stop")}],
            "usage": {"prompt_tokens": in_tokens, "completion_tokens": out_tokens, "total_tokens": in_tokens + out_tokens}}



def event_chunk(request_id, model, delta, finish_reason=None):
    return "data: " + json.dumps({
        "id": request_id, "object": "chat.completion.chunk", "created": int(time.time()),
        "model": model, "choices": [{"index": 0, "delta": delta, "finish_reason": finish_reason}]
    }) + "\n\n"


async def live_stream(session, req, request, funcs, choice):
    request_id = "chatcmpl-" + session.ident
    fragments = []
    try:
        yield event_chunk(request_id, req.model, {"role": "assistant"})
        while True:
            if session.cancel.is_set() or await request.is_disconnected():
                break
            try:
                kind, value = await asyncio.wait_for(session.queue.get(), timeout=0.25)
            except asyncio.TimeoutError:
                continue
            if kind == "delta":
                fragments.append(value)
                # Native Qwen tool-call markers must be parsed as a complete JSON
                # object; do not leak tool markup as assistant chat text.
                if not funcs:
                    yield event_chunk(request_id, req.model, {"content": value})
            elif kind == "error":
                yield "event: error\ndata: " + json.dumps({"error": {"message": value}}) + "\n\n"
                break
            elif kind == "done":
                answer = "".join(fragments)
                if funcs:
                    try:
                        calls, remaining = parse_calls(answer, funcs, choice)
                    except HTTPException as exc:
                        yield "event: error\ndata: " + json.dumps({"error": {"message": str(exc.detail)}}) + "\n\n"
                        break
                    if calls:
                        yield event_chunk(request_id, req.model, {
                            "tool_calls": [{"index": i, **c} for i, c in enumerate(calls)]})
                        reason = "tool_calls"
                    else:
                        if remaining:
                            yield event_chunk(request_id, req.model, {"content": remaining})
                        reason = "stop"
                else:
                    reason = "stop"
                yield event_chunk(request_id, req.model, {}, reason)
                yield "data: [DONE]\n\n"
                break
            elif kind == "worker_done":
                # Stream worker completed without a terminal event.
                break
    finally:
        cancel(session)
        forget(session)


@app.post("/v1/requests/{request_id}/cancel", dependencies=[Depends(auth)])
async def cancel_request(request_id: str):
    with SESSIONS_LOCK:
        session = SESSIONS.get(request_id)
    if session is None:
        raise HTTPException(404, "Request is not active on this gateway replica")
    cancel(session)
    return {"id": request_id, "status": "local_stream_stopped",
            "upstream_gpu_cancellation_confirmed": False}


@app.get("/health")
def health():
    return {"status": "ok", "service": "ndif-openai-adapter"}

@app.get("/v1/models", dependencies=[Depends(auth)])
def models():
    now = int(time.time())
    return {"object": "list", "data": [{"id": m, "object": "model", "created": now, "owned_by": "ndif"} for m in models_allowed()]}


@app.post("/v1/chat/completions", dependencies=[Depends(auth)])
async def chat(req: ChatRequest, request: Request):
    if not req.stream:
        return await completion(req)
    model, prompt, prompt_ids, options, funcs, choice = prepare(req)
    loop = asyncio.get_running_loop()
    session = begin(model, model.tokenizer, prompt, options, loop)
    return StreamingResponse(
        live_stream(session, req, request, funcs, choice), media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no",
                 "X-NDIF-Request-ID": session.ident})


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
