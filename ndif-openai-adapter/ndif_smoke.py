"""One-shot NDIF remote generation diagnostic. No keys printed.
Run only from the existing gateway deployment with NDIF_API_KEY set.
"""
# anyio's TypedAttributeSet.__init_subclass__ rejects attributes without type
# annotations. nnsight injects an un-annotated .save() method onto all tensor
# objects at import time. If anyio's asyncio backend loads AFTER nnsight, it
# encounters .save() on the SocketAttribute TypedAttributeSet and raises
#   TypeError: Attribute 'save' is missing its type annotation
# Fix: force-import anyio's asyncio backend before nnsight ever loads, so
# TypedAttributeSet is fully initialized and its __init_subclass__ has already
# run before nnsight patches anything.
import anyio._backends._asyncio  # noqa: F401 — must stay FIRST

import os
import sys
import time
import traceback

def log(*parts):
    print("NDIF_SMOKE:", *parts, flush=True)

def main():
    import nnsight
    from nnsight import CONFIG, TransformersModel
    if not os.getenv("NDIF_API_KEY"):
        log("FAIL: NDIF_API_KEY missing")
        return 2
    CONFIG.API.HOST = os.getenv("NDIF_HOST", "https://api.ndif.us")
    CONFIG.API.APIKEY = os.environ["NDIF_API_KEY"]
    log("BEGIN", "nnsight_version", getattr(nnsight, "__version__", "unknown"))
    try:
        available = nnsight.status()
        log("STATUS_OK", str(available)[:9000])
    except Exception as exc:
        log("STATUS_FAIL", type(exc).__name__, str(exc)[:900])
    # NDIF_BACKEND_MODEL is the real HF model ID sent to NDIF (e.g. Qwen/Qwen3-8B).
    # NDIF_MODELS is the alias Cursor sees (e.g. gpt-4o) — not a valid HF ID.
    model_id = os.getenv("NDIF_SMOKE_MODEL", os.getenv("NDIF_BACKEND_MODEL", "Qwen/Qwen3-8B"))
    log("GENERATE_BEGIN", model_id)
    start = time.monotonic()
    try:
        model = TransformersModel(model_id, task="text-generation")
        with model.generate("The capital of France is", remote=True, max_new_tokens=12) as tracer:
            result = tracer.result.save()
        output = model.tokenizer.decode(result[0], skip_special_tokens=True)
        log("GENERATE_OK", "seconds", round(time.monotonic() - start, 2), "response", repr(output[:600]))
        import asyncio
        import httpx

        async def adapter_check():
            # ASGI in-process HTTP, matching client auth/JSON without external DNS.
            from app import app
            transport = httpx.ASGITransport(app=app)
            async with httpx.AsyncClient(transport=transport, base_url="http://adapter-internal", timeout=100) as client:
                resp = await client.post(
                    "/v1/chat/completions",
                    headers={"Authorization": "Bearer " + os.environ["GATEWAY_API_KEY"]},
                    json={"model": model_id, "messages": [
                        {"role": "user", "content": "Answer with a single word: what is the capital of France?"}],
                        "max_tokens": 12}
                )
                try:
                    data = resp.json()
                except ValueError:
                    data = {"raw": resp.text[:700]}
                if resp.status_code == 200:
                    log("GATEWAY_OK", "status", resp.status_code, "response",
                        repr(data.get("choices", [{}])[0].get("message", {}).get("content", "")[:300]))
                else:
                    log("GATEWAY_FAIL", "status", resp.status_code, "detail", repr(data)[:900])
                return resp.status_code == 200

        passed = asyncio.run(adapter_check())
        return 0 if passed else 3
    except Exception as exc:
        log("GENERATE_FAIL", type(exc).__name__, str(exc)[:1300])
        log("TRACE", "".join(traceback.format_exception(type(exc), exc, exc.__traceback__))[-3000:])
        return 1

if __name__ == "__main__":
    sys.exit(main())
