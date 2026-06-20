"""Embedded-image enrichment pre-pass for the digital ingestion path.

MinerU extracts every embedded image in a digital PDF as a `type=image` element
(with a local `img_path`), including logos, signatures and decorative art. Left
alone these become content-less `"[image]"` chunks that pollute the vector store
(see memory/embedding_pitfalls.md). This pass runs *between* MinerU and the
chunker (see memory/pdf_parsing.md "内嵌图片 + 表格"):

    route -> MinerU -> enrich_images -> chunk -> embed

For each `type=image` element it asks a classifier whether the image carries
information:
  - valid  (table / chart / diagram / scanned_text) -> attach `enriched_markdown`
            so the chunk gets real, searchable content;
  - invalid (logo / signature / decorative / other) -> drop the element.

The classifier is injected (`classify`) so this module stays pure and offline-
testable; the real Gemini-Vision implementation lives in `gemini_image_verdict`.
The transform is non-mutating: a new list of (new, for enriched) dicts is
returned and the caller's content_list is left untouched.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Callable

from contract_rag.ingest.vision import encode_image_data_url, extract_text, parse_json_block

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class ImageVerdict:
    """A classifier's judgement of one extracted image."""
    valid: bool          # True => keep + describe; False => drop
    kind: str            # table | chart | diagram | scanned_text | logo | signature | ...
    content: str         # markdown reconstruction (only meaningful when valid)


Classifier = Callable[[str], ImageVerdict]

# An image whose *longer* bbox side is below this is treated as a non-content
# icon/seal/bullet and dropped WITHOUT spending a Gemini call. Units are MinerU
# bbox units (~px @ ~96dpi). Calibrated on 2026004: the audit-report icon is
# 36x28 (drop); real logos/figures are 142x105 and 410x124 (keep -> let Gemini
# judge). Using max(w,h) is deliberately conservative — only images small in
# *every* direction are pre-filtered, so wide letterheads / tall sidebars are
# never dropped by size alone.
MIN_CONTENT_IMAGE_DIM = 64


def _bbox_too_small(bbox: list | None, min_dim: int) -> bool:
    """True if the bbox is present and its longer side is below ``min_dim``."""
    if not bbox or len(bbox) < 4:
        return False  # can't measure -> not "obviously small", let Gemini judge
    width = bbox[2] - bbox[0]
    height = bbox[3] - bbox[1]
    return max(width, height) < min_dim


def parse_verdict(raw: str) -> ImageVerdict:
    """Turn a Gemini-Vision response into an ``ImageVerdict``.

    Unparseable output is treated as a *safe drop* (``valid=False``) rather than
    risking a content-less image chunk in the store. ``valid`` defaults to False
    when the model omits it; ``content`` is cleared whenever the verdict is
    invalid.
    """
    try:
        data = parse_json_block(raw)
    except ValueError:
        return ImageVerdict(False, "parse_error", "")

    valid = bool(data.get("valid", False))
    kind = str(data.get("type") or "")
    content = str(data.get("content") or "") if valid else ""
    return ImageVerdict(valid, kind, content)


def enrich_images(
    content_list: list[dict],
    classify: Classifier,
    *,
    min_dim: int = MIN_CONTENT_IMAGE_DIM,
) -> list[dict]:
    """Return a new content_list with `type=image` elements described or dropped.

    Non-image elements pass through unchanged (same object). For each image:
      - no ``img_path`` -> dropped (nothing to read);
      - bbox is obviously too small (``_bbox_too_small``) -> dropped WITHOUT a
        Gemini call (cheap icon/seal pre-filter);
      - otherwise classified: valid -> copied with ``enriched_markdown``;
        invalid -> dropped.

    The input list and its dicts are never mutated.
    """
    out: list[dict] = []
    for el in content_list:
        if el.get("type") != "image":
            out.append(el)
            continue

        img_path = el.get("img_path")
        if not img_path:
            continue  # nothing to classify -> drop

        if _bbox_too_small(el.get("bbox"), min_dim):
            continue  # obvious icon/seal -> drop, don't spend a Gemini call

        verdict = classify(img_path)
        if not verdict.valid:
            continue  # logo / signature / decorative -> drop

        out.append({**el, "enriched_markdown": verdict.content})
    return out


# --------------------------------------------------------------------------- #
# Real Gemini-Vision classifier (the I/O boundary; pure parts are in vision.py)
# --------------------------------------------------------------------------- #

_VISION_PROMPT = """You are validating an image extracted from a contract PDF.

Decide whether the image carries information worth indexing for search, or is
decorative/boilerplate noise.

Return ONLY a JSON object, no prose:
{"valid": <true|false>, "type": "<category>", "content": "<markdown>"}

valid=true categories: table, chart, diagram, scanned_text
valid=false categories: logo, signature, stamp, decorative, other

When valid=true, "content" MUST be a faithful Markdown reconstruction of the
image (tables as Markdown tables, preserving every number, $ sign, thousands
separator and unit exactly). When valid=false, "content" MUST be "".
"""


def gemini_image_verdict(img_path: str, *, model: str | None = None) -> ImageVerdict:
    """Classify+describe one extracted image with Gemini Vision (Vertex).

    The default model comes from config (``models.vision``). Network/decoding
    failures degrade to a safe drop rather than aborting a whole ingest.
    """
    from langchain_core.messages import HumanMessage

    from contract_rag.config import load_config
    from contract_rag.llm import LLM

    model = model or load_config().models.vision
    try:
        chat = LLM().get_custom_chat_object(model)
        data_url = encode_image_data_url(img_path)
        resp = chat.invoke(
            [
                HumanMessage(
                    content=[
                        {"type": "image_url", "image_url": {"url": data_url}},
                        {"type": "text", "text": _VISION_PROMPT},
                    ]
                )
            ]
        )
        return parse_verdict(extract_text(resp.content))
    except Exception as e:  # noqa: BLE001 - one bad image must not kill the ingest
        logger.warning("image verdict failed for %s: %s; dropping image", img_path, e)
        return ImageVerdict(False, "error", "")
