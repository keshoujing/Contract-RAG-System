"""chunk_id uniqueness: identical short content on one page must not collide.

Two clause chunks with the same (contract_id, page_start, content prefix) hash to
the same chunk_id -> same Weaviate UUID -> one object overwrites the other (silent
collapse the ingest guard then rejects). Seen on CUAD exhibit schedules with
repeated 'n.a.' cells.
"""
from contract_rag.ingest.chunker import chunk_content_list


def test_identical_content_same_page_gets_distinct_chunk_ids():
    elements = [
        {"type": "text", "text": "n.a.", "page_idx": 31},
        {"type": "text", "text_level": 1, "text": "Schedule", "page_idx": 31},
        {"type": "text", "text": "n.a.", "page_idx": 31},
    ]
    chunks = chunk_content_list(elements, contract_id="C1")
    ids = [c.chunk_id for c in chunks]
    assert len(chunks) == 2                      # both 'n.a.' clauses survive
    assert len(set(ids)) == len(ids), f"duplicate chunk_ids: {ids}"


def test_non_colliding_chunk_id_is_stable_across_runs():
    elements = [{"type": "text", "text": "a unique clause sentence", "page_idx": 0}]
    a = chunk_content_list(elements, contract_id="C1")[0].chunk_id
    b = chunk_content_list(elements, contract_id="C1")[0].chunk_id
    assert a == b  # determinism preserved (idempotent re-ingest)
