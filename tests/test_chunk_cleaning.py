"""Pre-embedding junk filter: drop content-less / bare-marker chunks so they
never reach the vector store (memory/ingestion_pipeline.md decision 12: "clean
before ingest: drop bare-heading / empty chunks"). Targets the real junk seen on
2026004: the orphan "9." 2-char chunk (a clause number MinerU emitted out of
order) and "[image]" placeholders.
"""
from __future__ import annotations

from contract_rag.ingest.chunker import Chunk, clean_chunks


def _chunk(content: str, chunk_type: str = "clause") -> Chunk:
    return Chunk(
        chunk_id="id", contract_id="C1", chunk_type=chunk_type,
        content=content, page_start=1, page_end=1,
    )


def test_drops_empty_and_whitespace_only() -> None:
    chunks = [_chunk(""), _chunk("   \n  "), _chunk("real clause text")]
    out = clean_chunks(chunks)
    assert [c.content for c in out] == ["real clause text"]


def test_drops_bare_clause_markers() -> None:
    chunks = [_chunk("9."), _chunk("(12)"), _chunk("3)"), _chunk("keep me")]
    out = clean_chunks(chunks)
    assert [c.content for c in out] == ["keep me"]


def test_drops_image_placeholder() -> None:
    out = clean_chunks([_chunk("[image]", chunk_type="image"), _chunk("body")])
    assert [c.content for c in out] == ["body"]


def test_keeps_numbered_clause_with_real_content() -> None:
    c = _chunk("4. Payment and Prices. Unless otherwise specified, terms are net 30.")
    assert clean_chunks([c]) == [c]


def test_keeps_table_chunk() -> None:
    t = _chunk("<table><tr><td>$3.17</td></tr></table>", chunk_type="table")
    assert clean_chunks([t]) == [t]


def test_preserves_order_of_kept_chunks() -> None:
    chunks = [_chunk("a clause"), _chunk("9."), _chunk("b clause")]
    assert [c.content for c in clean_chunks(chunks)] == ["a clause", "b clause"]
