"""
Digital-page rechunker for the Contract-RAG ingestion pipeline.

Input:  MinerU `content_list.json` (V1 verified format)
Output: list[Chunk] — section-aware, table-independent, size-capped

Design rules (see memory/digital_parsing_evaluation.md, ingestion_pipeline.md):
  - Filter `type=header/footer` (page-header / page-footer noise)
  - Headings (`type=text` with `text_level=1/2/3`) define section boundaries:
    they update `section_path` but do not themselves emit chunks.
  - Tables and images are always emitted as their own chunks (never merged
    into text).
  - Body text within the same section is accumulated to a soft size target;
    a new chunk is started when the next element would push the buffer over
    a hard cap.
  - Each chunk records `page_start`/`page_end` from the page_idx values of
    its contributing elements.

The output schema is the *unified* contract for downstream embed/Weaviate
ingestion, and is the schema that the scanned-page path (Gemini Vision) must
also produce — that's why this module accepts MinerU JSON but emits a
parser-agnostic Chunk shape.
"""
from __future__ import annotations

import hashlib
import json
import pathlib
import re
from dataclasses import asdict, dataclass, field, replace
from typing import Iterator, Literal

# ---------------------------------------------------------------------------
# Tunables (kept as module-level constants so they're easy to find and adjust
# without touching call sites)
# ---------------------------------------------------------------------------

# Soft size target in characters. The chunker stops growing a clause chunk
# once it reaches roughly this much text.
SOFT_TARGET_CHARS = 800

# Hard ceiling. The chunker will flush before adding an element that would
# push the chunk above this. A single element larger than this is emitted
# whole (and tagged `oversized=True`) — we never split mid-paragraph.
HARD_CAP_CHARS = 1500

# When a long clause/section is split at the size cap, the next chunk starts
# with this many trailing characters of the previous chunk, so context isn't
# lost at a mid-sentence boundary. Carried only on size-driven flushes (never
# across a heading/table/image boundary). Effective value is capped at
# soft_target // 2 to guarantee forward progress.
OVERLAP_CHARS = 200

# Types we drop entirely (page noise). Everything else either becomes a chunk
# or contributes to one.
DROP_TYPES = frozenset({"header", "footer"})

# `aside_text` is treated as body text (V1). If we find that asides pollute
# results we can promote it to its own chunk_type later.
TEXT_LIKE_TYPES = frozenset({"text", "aside_text"})

ChunkType = Literal["clause", "table", "image"]


# ---------------------------------------------------------------------------
# Output schema
# ---------------------------------------------------------------------------

@dataclass
class Chunk:
    """The unified chunk shape consumed by embed/Weaviate.

    Both the digital path (MinerU → this module) and the scanned path
    (Gemini OCR → a sibling module) must produce this shape.
    """
    chunk_id: str                       # Stable hash: contract_id + page_start + content prefix
    contract_id: str
    chunk_type: ChunkType               # "clause" | "table" | "image"
    content: str                        # markdown text (clause) or HTML (table) or caption (image)
    page_start: int                     # 1-indexed for human display
    page_end: int                       # 1-indexed for human display
    section_path: list[str] = field(default_factory=list)  # e.g. ["Terms and Conditions", "4. Payment"]
    bbox: list[float] | None = None     # First contributing element's bbox; None for multi-element clauses
    img_path: str | None = None         # Set for table / image chunks (MinerU's local png path)
    oversized: bool = False             # True if a single element exceeded HARD_CAP_CHARS


# ---------------------------------------------------------------------------
# Core chunker
# ---------------------------------------------------------------------------

def _stable_chunk_id(contract_id: str, page_start: int, content: str) -> str:
    """Deterministic id so reprocessing the same PDF yields the same ids."""
    h = hashlib.sha256()
    h.update(contract_id.encode("utf-8"))
    h.update(f":{page_start}:".encode("utf-8"))
    h.update(content[:200].encode("utf-8"))
    return h.hexdigest()[:16]


def _overlap_tail(content: str, n: int) -> str:
    """Last ~``n`` chars of ``content``, trimmed to start at a word boundary.

    Returns ``""`` when ``content`` is no longer than ``n`` (overlapping the
    whole chunk would just duplicate it). For CJK (no spaces) the tail is kept
    as-is.
    """
    if n <= 0 or len(content) <= n:
        return ""
    tail = content[-n:]
    space = tail.find(" ")
    if 0 <= space < len(tail) - 1:
        tail = tail[space + 1 :]
    return tail.strip()


class _ClauseBuffer:
    """Accumulates body-text elements for the current section until flush.

    On a *soft* (size-driven) flush it re-seeds itself with an overlap tail of
    the just-emitted chunk, so the next chunk shares context across the split.
    ``_has_new`` tracks whether real content was added since the last flush/seed,
    so a carried-over overlap that is never extended (e.g. at end-of-stream or a
    heading boundary) is discarded instead of emitted as a phantom chunk.
    """

    def __init__(self, contract_id: str, overlap_chars: int = 0):
        self.contract_id = contract_id
        self.overlap_chars = max(0, overlap_chars)
        self.parts: list[str] = []
        self.page_min: int | None = None
        self.page_max: int | None = None
        self.first_bbox: list[float] | None = None
        self._has_new = False

    def __len__(self) -> int:
        return sum(len(p) for p in self.parts) + max(0, len(self.parts) - 1) * 2  # +2 for "\n\n"

    def _reset(self) -> None:
        self.parts = []
        self.page_min = None
        self.page_max = None
        self.first_bbox = None
        self._has_new = False

    def add(self, text: str, page_idx: int, bbox: list[float] | None) -> None:
        if not text.strip():
            return
        self.parts.append(text)
        self._has_new = True
        if self.page_min is None or page_idx < self.page_min:
            self.page_min = page_idx
        if self.page_max is None or page_idx > self.page_max:
            self.page_max = page_idx
        if self.first_bbox is None and bbox is not None:
            self.first_bbox = list(bbox)

    def flush(self, section_path: list[str], *, soft: bool = False, oversized: bool = False) -> Chunk | None:
        # Empty, or only a carried-over overlap with no new content -> emit nothing.
        if not self.parts or self.page_min is None or not self._has_new:
            self._reset()
            return None
        content = "\n\n".join(self.parts)
        # MinerU pages are 0-indexed; humans expect 1-indexed
        p_start = self.page_min + 1
        p_end = (self.page_max or self.page_min) + 1
        chunk = Chunk(
            chunk_id=_stable_chunk_id(self.contract_id, p_start, content),
            contract_id=self.contract_id,
            chunk_type="clause",
            content=content,
            page_start=p_start,
            page_end=p_end,
            section_path=list(section_path),
            bbox=self.first_bbox,
            oversized=oversized,
        )
        last_page = self.page_max if self.page_max is not None else self.page_min
        self._reset()
        # Size-driven split: carry an overlap tail into the next chunk. Boundary
        # flushes (heading/table/image/end) leave a clean break (soft=False).
        if soft and self.overlap_chars:
            tail = _overlap_tail(content, self.overlap_chars)
            if tail:
                self.parts = [tail]
                self.page_min = last_page
                self.page_max = last_page
                # _has_new stays False: a pure overlap is not new content.
        return chunk


def _dedup_chunk_ids(chunks: list[Chunk]) -> list[Chunk]:
    """Guarantee chunk_ids are unique within a contract.

    ``_stable_chunk_id`` hashes contract_id + page_start + content prefix, so two
    chunks with identical short content on the same page (e.g. repeated ``n.a.``
    cells in an exhibit schedule) collide to one Weaviate UUID and silently
    collapse. Re-salt only the *later* occurrences, deterministically by their
    ordinal, so non-colliding ids stay byte-for-byte stable (idempotent re-ingest)
    and re-salting itself is reproducible across runs.
    """
    seen: dict[str, int] = {}
    out: list[Chunk] = []
    for c in chunks:
        n = seen.get(c.chunk_id, 0)
        seen[c.chunk_id] = n + 1
        if n:
            salted = hashlib.sha256(f"{c.chunk_id}:{n}".encode("utf-8")).hexdigest()[:16]
            c = replace(c, chunk_id=salted)
        out.append(c)
    return out


def chunk_content_list(
    content_list: list[dict],
    contract_id: str,
    soft_target: int = SOFT_TARGET_CHARS,
    hard_cap: int = HARD_CAP_CHARS,
    overlap: int = OVERLAP_CHARS,
) -> list[Chunk]:
    """Walk a MinerU content_list and produce the unified Chunk shape.

    Args:
        content_list: parsed JSON list of MinerU elements.
        contract_id: stable identifier (V1: task_id is fine if contract_number
            hasn't been extracted yet).
        soft_target, hard_cap, overlap: see module-level constants. ``overlap``
            is capped at ``soft_target // 2`` to guarantee forward progress.
    """
    out: list[Chunk] = []
    section_path: list[str] = []
    overlap = min(max(0, overlap), soft_target // 2)
    buf = _ClauseBuffer(contract_id, overlap_chars=overlap)

    def flush_buf(*, soft: bool = False, oversized: bool = False) -> None:
        chunk = buf.flush(section_path, soft=soft, oversized=oversized)
        if chunk is not None:
            out.append(chunk)

    for el in content_list:
        t = el.get("type")

        if t in DROP_TYPES:
            continue

        # ----- Heading: redefines section_path, no chunk emitted -----
        if t == "text" and el.get("text_level") in (1, 2, 3):
            level = el["text_level"]
            heading = (el.get("text") or "").strip()
            # Closing the previous section: flush any pending body text
            flush_buf()
            # Trim section_path to the new heading's level - 1, then append
            section_path = section_path[: level - 1] + [heading]
            continue

        # ----- Table: independent chunk -----
        if t == "table":
            flush_buf()
            html = el.get("table_body") or ""
            caption = " ".join(el.get("table_caption") or [])
            footnote = " ".join(el.get("table_footnote") or [])
            # Preserve caption / footnote as plain text wrappers around the HTML
            parts = []
            if caption:
                parts.append(caption)
            parts.append(html)
            if footnote:
                parts.append(footnote)
            content = "\n\n".join(parts)
            page = (el.get("page_idx") or 0) + 1
            out.append(Chunk(
                chunk_id=_stable_chunk_id(contract_id, page, content),
                contract_id=contract_id,
                chunk_type="table",
                content=content,
                page_start=page,
                page_end=page,
                section_path=list(section_path),
                bbox=list(el.get("bbox") or []) or None,
                img_path=el.get("img_path"),
            ))
            continue

        # ----- Image: independent chunk -----
        # Prefer the enrichment pass's markdown (see image_enrichment.py); fall
        # back to MinerU's caption/footnote, then a bare "[image]" placeholder.
        if t == "image":
            flush_buf()
            enriched = (el.get("enriched_markdown") or "").strip()
            if enriched:
                content = enriched
            else:
                caption = " ".join(el.get("image_caption") or [])
                footnote = " ".join(el.get("image_footnote") or [])
                content = "\n\n".join(p for p in (caption, footnote) if p) or "[image]"
            page = (el.get("page_idx") or 0) + 1
            out.append(Chunk(
                chunk_id=_stable_chunk_id(contract_id, page, content + (el.get("img_path") or "")),
                contract_id=contract_id,
                chunk_type="image",
                content=content,
                page_start=page,
                page_end=page,
                section_path=list(section_path),
                bbox=list(el.get("bbox") or []) or None,
                img_path=el.get("img_path"),
            ))
            continue

        # ----- Body text-ish: accumulate -----
        if t in TEXT_LIKE_TYPES:
            text = (el.get("text") or "").strip()
            if not text:
                continue
            page_idx = el.get("page_idx") or 0
            bbox = el.get("bbox")
            elem_len = len(text)

            # If this single element alone exceeds the hard cap, flush whatever
            # we have, then emit this element as its own oversized chunk.
            if elem_len > hard_cap:
                flush_buf()
                buf.add(text, page_idx, bbox)
                flush_buf(oversized=True)
                continue

            # If adding this would push us over the hard cap, flush first (soft:
            # carry overlap so a clause cut here keeps shared context).
            if len(buf) > 0 and len(buf) + elem_len > hard_cap:
                flush_buf(soft=True)

            buf.add(text, page_idx, bbox)

            # If we've reached the soft target, flush proactively (soft: overlap).
            if len(buf) >= soft_target:
                flush_buf(soft=True)
            continue

        # Unknown type: keep but tag in content so we notice
        # (We don't expect this in V1 — MinerU's 6 types are exhaustive.)
        text = (el.get("text") or "").strip()
        if text:
            buf.add(f"[unknown type={t}] {text}", el.get("page_idx") or 0, el.get("bbox"))

    flush_buf()
    return _dedup_chunk_ids(out)


# ---------------------------------------------------------------------------
# Pre-embedding cleaning (drop junk so it never reaches the vector store)
# ---------------------------------------------------------------------------

# A chunk whose entire content is just a clause marker like "9.", "(12)", "3)".
# These appear when MinerU emits a clause number as its own out-of-order element.
_BARE_MARKER_RE = re.compile(r"^[(\[]?\d{1,3}[.)\]]?$")


def _is_junk_chunk(chunk: Chunk) -> bool:
    """True if a chunk carries no indexable content and should be dropped."""
    text = chunk.content.strip()
    if not text:
        return True              # empty / whitespace-only
    if text == "[image]":
        return True              # un-enriched image placeholder
    if _BARE_MARKER_RE.match(text):
        return True              # bare clause marker ("9.", "(12)", "3)")
    return False


def clean_chunks(chunks: list[Chunk]) -> list[Chunk]:
    """Drop content-less / bare-marker chunks, preserving order."""
    return [c for c in chunks if not _is_junk_chunk(c)]


# ---------------------------------------------------------------------------
# CLI for local inspection
# ---------------------------------------------------------------------------

def _summarize(chunks: list[Chunk]) -> dict:
    by_type: dict[str, int] = {}
    sizes: list[int] = []
    pages: set[int] = set()
    oversized = 0
    for c in chunks:
        by_type[c.chunk_type] = by_type.get(c.chunk_type, 0) + 1
        sizes.append(len(c.content))
        pages.update(range(c.page_start, c.page_end + 1))
        if c.oversized:
            oversized += 1
    sizes.sort()
    return {
        "n_chunks": len(chunks),
        "by_type": by_type,
        "pages_covered": sorted(pages),
        "oversized": oversized,
        "size_min": sizes[0] if sizes else 0,
        "size_p50": sizes[len(sizes) // 2] if sizes else 0,
        "size_p90": sizes[int(len(sizes) * 0.9)] if sizes else 0,
        "size_max": sizes[-1] if sizes else 0,
    }


def main() -> None:
    import argparse

    parser = argparse.ArgumentParser(description="Chunk a MinerU content_list.json")
    parser.add_argument("input", help="path to content_list.json")
    parser.add_argument("--contract-id", default="TEST", help="contract_id to embed in chunks")
    parser.add_argument("--out", default=None, help="output chunks.json path (default: alongside input)")
    parser.add_argument("--soft", type=int, default=SOFT_TARGET_CHARS)
    parser.add_argument("--hard", type=int, default=HARD_CAP_CHARS)
    args = parser.parse_args()

    in_path = pathlib.Path(args.input)
    content_list = json.loads(in_path.read_text(encoding="utf-8"))
    chunks = chunk_content_list(
        content_list, contract_id=args.contract_id,
        soft_target=args.soft, hard_cap=args.hard,
    )
    out_path = pathlib.Path(args.out) if args.out else in_path.with_name("chunks.json")
    out_path.write_text(
        json.dumps([asdict(c) for c in chunks], ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    summary = _summarize(chunks)
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    print(f"wrote {out_path}")


if __name__ == "__main__":
    main()
