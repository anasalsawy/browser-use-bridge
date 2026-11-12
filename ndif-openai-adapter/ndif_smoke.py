"""One-shot NDIF remote generation diagnostic. No keys printed.
Run only from the existing gateway deployment with NDIF_API_KEY set.
"""
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
    model_id = os.getenv("NDIF_SMOKE_MODEL", "Qwen/Qwen3-8B")
    log("GENERATE_BEGIN", model_id)
    start = time.monotonic()
    try:
        model = TransformersModel(model_id, task="text-generation")
        with model.generate("The capital of France is", remote=True, max_new_tokens=12) as tracer:
            result = tracer.result.save()
        output = model.tokenizer.decode(result[0], skip_special_tokens=True)
        log("GENERATE_OK", "seconds", round(time.monotonic() - start, 2), "response", repr(output[:600]))
        return 0
    except Exception as exc:
        log("GENERATE_FAIL", type(exc).__name__, str(exc)[:1300])
        log("TRACE", "".join(traceback.format_exception(type(exc), exc, exc.__traceback__))[-3000:])
        return 1

if __name__ == "__main__":
    sys.exit(main())
