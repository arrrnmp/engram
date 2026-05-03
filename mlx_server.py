#!/usr/bin/env python3
"""
OpenAI-compatible /v1/embeddings server for Engram on Apple Silicon.

Wraps mlx-embeddings (Qwen3-VL-Embedding-2B) with a FastAPI HTTP server that
speaks the same protocol as upstream vLLM, so QwenVLProvider works unchanged.

On first run, downloads Qwen/Qwen3-VL-Embedding-2B and converts it to a
quantized MLX checkpoint at ~/.cache/engram/mlx/<model-slug>-<q-mode>.
Subsequent starts load from that checkpoint directly.

Usage:
    uv run python mlx_server.py [--model MODEL] [--port PORT] [--q-mode MODE]
"""

import argparse
import base64
import io
import os
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Union

import uvicorn
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

# ── CLI args ──────────────────────────────────────────────────────────────────

_parser = argparse.ArgumentParser(description="MLX OpenAI-compatible embedding server")
_parser.add_argument("--model", default="Qwen/Qwen3-VL-Embedding-2B")
_parser.add_argument("--port", type=int, default=int(os.environ.get("PORT", "8001")))
_parser.add_argument(
    "--q-mode",
    dest="q_mode",
    default="nvfp4",
    choices=["affine", "mxfp4", "nvfp4", "mxfp8", "none"],
    help="Quantization mode for the converted checkpoint (default: nvfp4)",
)
_args = _parser.parse_args()

MODEL_ID = _args.model

# ── Checkpoint management ─────────────────────────────────────────────────────

_Q_CONVERT_PARAMS: dict[str, dict] = {
    "affine": {"q_group_size": 64, "q_bits": 4, "q_mode": "affine"},
    "mxfp4": {"q_group_size": 32, "q_bits": 4, "q_mode": "mxfp4"},
    "nvfp4": {"q_group_size": 16, "q_bits": 4, "q_mode": "nvfp4"},
    "mxfp8": {"q_group_size": 32, "q_bits": 8, "q_mode": "mxfp8"},
}


def _checkpoint_path() -> Path:
    slug = MODEL_ID.replace("/", "--")
    suffix = f"-{_args.q_mode}" if _args.q_mode != "none" else "-bf16"
    return Path.home() / ".cache" / "engram" / "mlx" / f"{slug}{suffix}"


def ensure_checkpoint() -> str:
    """Convert the base HuggingFace model to a local MLX checkpoint if not already done.

    mlx_embeddings.convert() loads via transformers, which handles tie_word_embeddings
    correctly — the saved checkpoint has both weight keys, so load() is clean.
    """
    path = _checkpoint_path()
    if path.exists():
        print(f"[mlx-server] Checkpoint: {path}", flush=True)
        return str(path)

    print(f"[mlx-server] First run: converting {MODEL_ID} → {path}", flush=True)
    print("[mlx-server] Downloading model weights (this runs once)...", flush=True)

    from mlx_embeddings.convert import convert

    if _args.q_mode != "none":
        params = _Q_CONVERT_PARAMS[_args.q_mode]
        convert(hf_path=MODEL_ID, mlx_path=str(path), quantize=True, **params)
    else:
        convert(hf_path=MODEL_ID, mlx_path=str(path))

    print("[mlx-server] Conversion complete.", flush=True)
    return str(path)


# ── Globals loaded at startup ─────────────────────────────────────────────────

_model = None
_processor = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _model, _processor
    checkpoint = ensure_checkpoint()
    print(f"[mlx-server] Loading {_args.q_mode} checkpoint...", flush=True)
    from mlx_embeddings import load
    _model, _processor = load(checkpoint)
    print("[mlx-server] Ready.", flush=True)
    yield


app = FastAPI(lifespan=lifespan)


# ── Routes ────────────────────────────────────────────────────────────────────

@app.get("/health")
def health():
    return {"status": "ok"}


class EmbedRequest(BaseModel):
    model: str
    input: Union[str, list[Any]]
    encoding_format: str = "float"


def _to_list(arr) -> list[float]:
    try:
        import mlx.core as mx
        if isinstance(arr, mx.array):
            return arr.tolist()
    except ImportError:
        pass
    try:
        import numpy as np
        if isinstance(arr, np.ndarray):
            return arr.tolist()
    except ImportError:
        pass
    return list(arr)


def _embed_texts(texts: list[str]) -> list[list[float]]:
    import mlx.core as mx
    tokenizer = _processor.processor.tokenizer
    all_ids = [tokenizer.encode(t) for t in texts]
    max_len = max(len(ids) for ids in all_ids)
    pad_id = tokenizer.eos_token_id
    padded = []
    masks = []
    for ids in all_ids:
        pad_len = max_len - len(ids)
        padded.append(ids + [pad_id] * pad_len)
        masks.append([1] * len(ids) + [0] * pad_len)
    input_ids = mx.array(padded)
    attention_mask = mx.array(masks)
    output = _model(input_ids=input_ids, attention_mask=attention_mask)
    return [_to_list(row) for row in output.text_embeds]


def _embed_multimodal(content: list[dict]) -> list[float]:
    import mlx.core as mx
    from PIL import Image
    text_parts: list[str] = []
    images: list[Image.Image] = []

    for item in content:
        kind = item.get("type", "")
        if kind == "text":
            text_parts.append(item.get("text", ""))
        elif kind == "image_url":
            url = (item.get("image_url") or {}).get("url", "")
            if url.startswith("data:"):
                try:
                    _header, encoded = url.split(",", 1)
                    images.append(Image.open(io.BytesIO(base64.b64decode(encoded))).convert("RGB"))
                except Exception:
                    pass  # skip malformed / unsupported images

    text = " ".join(text_parts)

    # Text-only fallback
    if not images:
        tokenizer = _processor.processor.tokenizer
        ids = tokenizer.encode(text or "")
        if ids is None:
            ids = []
        input_ids = mx.array([ids])
        attention_mask = mx.ones_like(input_ids)
        output = _model(input_ids=input_ids, attention_mask=attention_mask)
        return _to_list(output.text_embeds[0])

    # Use prepare_embedding_inputs — applies the chat template which inserts
    # image tokens into input_ids at the correct positions.  Calling the raw
    # transformers processor directly (previous approach) skipped the chat
    # template step so image_ids was never set, causing the 500 error.
    try:
        embedding_input: dict = {"image": images if len(images) > 1 else images[0]}
        if text:
            embedding_input["text"] = text
        model_inputs = _processor.prepare_embedding_inputs(embedding_input)
        output = _model(**model_inputs)
        return _to_list(output.text_embeds[0])
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Processor error: {e}") from e


@app.post("/v1/embeddings")
async def embeddings(req: EmbedRequest):
    if _model is None:
        raise HTTPException(status_code=503, detail="Model not loaded yet")

    inp = req.input
    try:
        if isinstance(inp, str):
            vecs = _embed_texts([inp])
            data = [{"object": "embedding", "embedding": vecs[0], "index": 0}]

        elif isinstance(inp, list) and inp and isinstance(inp[0], str):
            vecs = _embed_texts(inp)
            data = [{"object": "embedding", "embedding": v, "index": i}
                    for i, v in enumerate(vecs)]

        elif isinstance(inp, list) and inp and isinstance(inp[0], dict):
            vec = _embed_multimodal(inp)
            data = [{"object": "embedding", "embedding": vec, "index": 0}]

        else:
            raise HTTPException(status_code=422, detail=f"Unsupported input type: {type(inp)}")

    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    finally:
        try:
            import mlx.core as mx
            mx.metal.clear_cache()
        except Exception:
            pass

    return {
        "object": "list",
        "data": data,
        "model": req.model,
        "usage": {"prompt_tokens": 0, "total_tokens": 0},
    }


# ── Entry point ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=_args.port, log_level="warning")
