"""NDIF streaming bridge using NNsight's documented nnsight.local() boundary.

The local callback receives per-step streamer token IDs while NDIF is still
generating. No post-hoc chunking. Closing the client connection closes the
local stream and NDIF subscription; server-side GPU cancellation is NOT promised.
"""
from __future__ import annotations
import asyncio
import os
import threading
import uuid
from dataclasses import dataclass, field
from typing import Any

import nnsight
from nnsight import CONFIG, TransformersModel

SESSIONS: dict[str, "Session"] = {}
SESSIONS_LOCK = threading.Lock()

@dataclass
class Session:
    ident: str
    loop: Any
    queue: asyncio.Queue
    tokenizer: Any
    cancel: threading.Event = field(default_factory=threading.Event)
    received: list[int] = field(default_factory=list)
    previous_text: str = ""
    backend: Any = None
    done: bool = False

    def emit(self, token: Any):
        if self.cancel.is_set():
            return
        ids = token.detach().cpu().reshape(-1).tolist() if hasattr(token, "detach") else (
            token if isinstance(token, list) else [token])
        ids = [int(x) for x in ids]
        # The streamer emits a prompt block first. Do not forward prompt tokens.
        if len(ids) != 1:
            return
        self.received.extend(ids)
        current = self.tokenizer.decode(self.received, skip_special_tokens=True, clean_up_tokenization_spaces=False)
        if current.startswith(self.previous_text):
            delta = current[len(self.previous_text):]
            if delta:
                self.loop.call_soon_threadsafe(self.queue.put_nowait, ("delta", delta))
        else:
            # Decoding may revise the last Unicode fragment: replace is unsafe
            # for OpenAI SSE. Do not emit corrupted fragments.
            self.loop.call_soon_threadsafe(self.queue.put_nowait,
                                           ("error", "Tokenizer produced non-prefix output"))
            self.cancel.set()
        self.previous_text = current


def _local_token(token: Any, session_id: str):
    # This function runs on the adapter through nnsight.local(), not on GPU.
    with SESSIONS_LOCK:
        session = SESSIONS.get(session_id)
    if session is not None:
        session.emit(token)


def begin(model: TransformersModel, tokenizer: Any, prompt: str,
          generation_args: dict[str, Any], loop: Any) -> Session:
    ident = uuid.uuid4().hex
    session = Session(ident, loop, asyncio.Queue(), tokenizer)
    with SESSIONS_LOCK:
        SESSIONS[ident] = session

    def work():
        try:
            CONFIG.API.HOST = os.getenv("NDIF_HOST", "https://api.ndif.us")
            CONFIG.API.APIKEY = os.environ["NDIF_API_KEY"]
            CONFIG.APP.REMOTE_LOGGING = False
            with model.generate(prompt, remote=True, **generation_args) as tracer:
                session.backend = tracer.backend
                tracer.all()
                with nnsight.local():
                    _local_token(model.generator.streamer.output, ident)
            if not session.cancel.is_set():
                loop.call_soon_threadsafe(session.queue.put_nowait, ("done", None))
        except Exception as exc:
            if not session.cancel.is_set():
                loop.call_soon_threadsafe(session.queue.put_nowait,
                                          ("error", type(exc).__name__ + ": NDIF stream failed"))
        finally:
            session.done = True
            loop.call_soon_threadsafe(session.queue.put_nowait, ("worker_done", None))

    session.task = asyncio.create_task(asyncio.to_thread(work))
    return session


def cancel(session: Session):
    session.cancel.set()
    backend = session.backend
    if backend is not None and hasattr(backend, "close"):
        try:
            backend.close()
        except Exception:
            pass


def forget(session: Session):
    # Local streaming callbacks must never write into a finished request.
    with SESSIONS_LOCK:
        SESSIONS.pop(session.ident, None)
