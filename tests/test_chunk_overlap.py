"""When a long clause/section is split at the size cap, consecutive chunks
should share an overlap (the tail of chunk N reappears at the start of chunk
N+1), so a clause split mid-sentence keeps context on both sides. Overlap is
carried only on *size-driven* flushes — never across a heading/table/image
boundary (those are clean semantic breaks).
"""
from __future__ import annotations

from contract_rag.ingest.chunker import chunk_content_list


def _text(s: str, page_idx: int = 0, **extra) -> dict:
    return {"type": "text", "text": s, "page_idx": page_idx, **extra}


def test_size_driven_split_carries_overlap() -> None:
    els = [_text("A" * 100), _text("B" * 100)]
    chunks = chunk_content_list(els, contract_id="C1", soft_target=80, hard_cap=150, overlap=20)
    assert len(chunks) == 2
    tail = chunks[0].content[-20:]
    assert chunks[1].content.startswith(tail)  # chunk 2 begins with chunk 1's tail


def test_overlap_zero_means_no_shared_text() -> None:
    els = [_text("A" * 100), _text("B" * 100)]
    chunks = chunk_content_list(els, contract_id="C1", soft_target=80, hard_cap=150, overlap=0)
    assert "A" not in chunks[1].content


def test_no_overlap_across_heading_boundary() -> None:
    els = [_text("X" * 100), _text("Heading", text_level=1), _text("Y" * 100)]
    chunks = chunk_content_list(els, contract_id="C1", soft_target=80, hard_cap=150, overlap=20)
    y_chunk = next(c for c in chunks if "Y" in c.content)
    assert not y_chunk.content.startswith("X")  # new section starts clean


def test_no_phantom_trailing_overlap_chunk() -> None:
    # the overlap carried after the LAST real content must not become its own chunk
    els = [_text("A" * 100), _text("B" * 100)]
    chunks = chunk_content_list(els, contract_id="C1", soft_target=80, hard_cap=150, overlap=20)
    assert all(len(c.content) > 20 for c in chunks)
