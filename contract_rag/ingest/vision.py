"""Deterministic helpers shared by the Gemini-Vision image classifier and the
scanned-page OCR provider.

A Gemini call has exactly one untestable part — the network round-trip. The work
around it (encoding an image to a data URL, pulling text out of a LangChain
response, parsing the structured JSON Gemini returns) is pure and lives here so
it can be unit-tested offline. The thin glue that actually calls the model lives
in `image_enrichment.py` / `ocr.py`.
"""
from __future__ import annotations

import base64
import json
import pathlib
import re


def encode_bytes_data_url(data: bytes, fmt: str = "png") -> str:
    """Return a base64 `data:` URL for raw image bytes (e.g. a rendered page)."""
    b64 = base64.b64encode(data).decode("ascii")
    mime = "jpeg" if fmt.lower() in ("jpg", "jpeg") else fmt.lower()
    return f"data:image/{mime};base64,{b64}"


def encode_image_data_url(path: str | pathlib.Path) -> str:
    """Read an image file and return a base64 `data:` URL for a Gemini prompt."""
    p = pathlib.Path(path)
    fmt = p.suffix.lower().lstrip(".") or "png"
    return encode_bytes_data_url(p.read_bytes(), fmt=fmt)


def extract_text(content) -> str:
    """Normalize a LangChain `message.content` to a string.

    `ChatGoogleGenerativeAI` returns either a plain string or a list of content
    blocks (`{"type": "text", "text": ...}` plus possibly non-text blocks). We
    concatenate the text blocks faithfully (no separator) so structured output
    like JSON is not corrupted by injected spaces.
    """
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(
            b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text"
        )
    return str(content)


_FENCE_RE = re.compile(r"```(?:json)?\s*(.*?)\s*```", re.DOTALL)


def loads_lenient(raw: str):
    """Parse JSON (object or array) out of a model response.

    Tolerates the shapes Gemini emits: a bare value, a ```json fenced block, or
    JSON embedded in surrounding prose. Returns the parsed value (``dict`` or
    ``list``). Raises ``ValueError`` if nothing parseable is found.
    """
    text = raw.strip()
    candidates: list[str] = []

    m = _FENCE_RE.search(text)
    if m:
        candidates.append(m.group(1).strip())
    candidates.append(text)
    # JSON embedded in prose: slice from the first opener to the last closer.
    for opener, closer in (("[", "]"), ("{", "}")):
        start, end = text.find(opener), text.rfind(closer)
        if start != -1 and end != -1 and end > start:
            candidates.append(text[start : end + 1])

    for candidate in candidates:
        try:
            return json.loads(candidate)
        except json.JSONDecodeError:
            continue

    raise ValueError(f"No parseable JSON in model response: {raw[:200]!r}")


def parse_json_block(raw: str) -> dict:
    """Parse a JSON *object* out of a model response (see ``loads_lenient``)."""
    data = loads_lenient(raw)
    if not isinstance(data, dict):
        raise ValueError(f"Expected a JSON object, got {type(data).__name__}")
    return data
