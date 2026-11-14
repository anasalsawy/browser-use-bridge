"""Smoke test for the sawii-sync OpenAI adapter.

Sends a real HTTP request through the ASGI app to verify the full chain:
  Cursor-side OpenAI call → adapter → sawii-sync /v1/chat → reply

No NDIF or nnsight imports here — the adapter no longer touches them.
"""
import asyncio
import os
import sys
import time
import traceback


def log(*parts):
    print("SMOKE:", *parts, flush=True)


def main():
    # Mandatory env
    gateway_key = os.getenv("GATEWAY_API_KEY", "")
    if not gateway_key:
        log("FAIL: GATEWAY_API_KEY missing")
        return 2

    sync_url = os.getenv("SYNC_URL", "").strip().rstrip("/")
    if not sync_url:
        log("FAIL: SYNC_URL missing — set it to the sawii-sync Railway URL")
        return 2

    model = os.getenv("NDIF_MODELS", "gpt-4o").split(",")[0].strip()
    log("BEGIN", f"model={model}", f"sync_url={sync_url}")

    # 1. Quick reachability check on sync's /health (or root)
    import httpx
    start = time.monotonic()
    try:
        resp = httpx.get(sync_url + "/health", timeout=15)
        log("SYNC_HEALTH", resp.status_code, resp.text[:200])
    except Exception as exc:
        log("SYNC_HEALTH_FAIL", type(exc).__name__, str(exc)[:300])
        # Non-fatal — maybe /health doesn't exist; try the chat anyway

    # 2. End-to-end through the adapter (in-process ASGI, no network hop)
    async def adapter_check():
        from app import app
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(
            transport=transport,
            base_url="http://adapter-internal",
            timeout=120.0,
        ) as client:
            resp = await client.post(
                "/v1/chat/completions",
                headers={"Authorization": "Bearer " + gateway_key},
                json={
                    "model": model,
                    "messages": [
                        {"role": "user", "content": "Answer with one word: capital of France?"}
                    ],
                    "max_tokens": 32,
                },
            )
            try:
                data = resp.json()
            except ValueError:
                data = {"raw": resp.text[:700]}

            if resp.status_code == 200:
                reply = (data.get("choices") or [{}])[0].get("message", {}).get("content", "")
                log("GATEWAY_OK", "seconds", round(time.monotonic() - start, 2),
                    "reply", repr(reply[:300]))
                return True
            else:
                log("GATEWAY_FAIL", "status", resp.status_code, "detail", repr(data)[:900])
                return False

    try:
        passed = asyncio.run(adapter_check())
        return 0 if passed else 3
    except Exception as exc:
        log("EXCEPTION", type(exc).__name__, str(exc)[:1300])
        log("TRACE", "".join(traceback.format_exception(type(exc), exc, exc.__traceback__))[-3000:])
        return 1


if __name__ == "__main__":
    sys.exit(main())
