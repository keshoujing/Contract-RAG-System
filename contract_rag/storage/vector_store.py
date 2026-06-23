"""Weaviate vector store for contract chunks (BYO vectors).

Rewrite of the old ``src/vectorDB.py``, aligned with decisions 10 & 12:
  - chunks carry ONLY ``contract_id`` (+ structural metadata), never the
    denormalized ``vendor_name``/dates the old code wrote to every chunk;
  - vectors are computed client-side with gemini-embedding-2 and pushed BYO
    (``vectorizer=none``, cosine distance);
  - the old PyPDFLoader + RecursiveCharacterTextSplitter + summary-chunk path is
    gone — chunks come from the MinerU-aware chunker.

The ``ingest_chunks`` guard directly defends the silent-collapse bug from
``memory/embedding_pitfalls.md`` (50 chunks → 3 vectors): it asserts the
embedding returns one vector per chunk, AND re-counts objects after insert.
"""
from __future__ import annotations

import json
import os
import uuid

import weaviate
import weaviate.classes.config as wc
from weaviate.classes.query import Filter

from contract_rag.config import load_config
from contract_rag.ingest.chunker import Chunk
from contract_rag.llm import LLM
from contract_rag.storage import db

# Deterministic namespace so the same chunk_id always maps to the same Weaviate
# UUID (idempotent re-ingest).
_UUID_NS = uuid.NAMESPACE_DNS

_client: weaviate.WeaviateClient | None = None


def _weaviate_host() -> str:
    """Weaviate host: ``localhost`` locally, the ``weaviate`` service in Docker."""
    return os.getenv("WEAVIATE_HOST", "localhost")


def _weaviate_port() -> int:
    return int(os.getenv("WEAVIATE_PORT", "8080"))


def get_client() -> weaviate.WeaviateClient:
    global _client
    if _client is None or not _client.is_connected():
        _client = weaviate.connect_to_local(host=_weaviate_host(), port=_weaviate_port())
    return _client


def close_client() -> None:
    global _client
    if _client is not None and _client.is_connected():
        _client.close()
    _client = None


def _collection_name() -> str:
    return load_config().weaviate.collection


def _schema_properties() -> list[wc.Property]:
    return [
        wc.Property(name="text", data_type=wc.DataType.TEXT),
        wc.Property(name="contract_id", data_type=wc.DataType.TEXT),
        wc.Property(name="file_no", data_type=wc.DataType.TEXT),
        wc.Property(name="contract_number", data_type=wc.DataType.TEXT),
        wc.Property(name="chunk_type", data_type=wc.DataType.TEXT),
        wc.Property(name="page_start", data_type=wc.DataType.INT),
        wc.Property(name="page_end", data_type=wc.DataType.INT),
        wc.Property(name="section_path", data_type=wc.DataType.TEXT),
        wc.Property(name="bbox", data_type=wc.DataType.NUMBER_ARRAY),
        wc.Property(name="img_path", data_type=wc.DataType.TEXT),
        wc.Property(name="oversized", data_type=wc.DataType.BOOL),
    ]


def _ensure_collection_properties(coll) -> None:
    existing = {p.name for p in coll.config.get().properties}
    for prop in _schema_properties():
        if prop.name not in existing:
            coll.config.add_property(prop)


def ensure_collection() -> None:
    """Create the collection with the BYO-vector schema if it doesn't exist."""
    client = get_client()
    name = _collection_name()
    if client.collections.exists(name):
        _ensure_collection_properties(client.collections.get(name))
        return
    client.collections.create(
        name=name,
        vectorizer_config=wc.Configure.Vectorizer.none(),
        vector_index_config=wc.Configure.VectorIndex.hnsw(
            distance_metric=wc.VectorDistances.COSINE
        ),
        properties=_schema_properties(),
    )


def reset_collection() -> None:
    """Drop and recreate the collection. Used to start verification clean."""
    client = get_client()
    name = _collection_name()
    if client.collections.exists(name):
        client.collections.delete(name)
    ensure_collection()


def delete_contract(contract_id: str) -> None:
    """Remove all chunks for a contract (re-ingest / overwrite support)."""
    client = get_client()
    name = _collection_name()
    if not client.collections.exists(name):
        return
    coll = client.collections.get(name)
    coll.data.delete_many(where=Filter.by_property("contract_id").equal(contract_id))


def count_contract(contract_id: str) -> int:
    coll = get_client().collections.get(_collection_name())
    res = coll.aggregate.over_all(
        total_count=True,
        filters=Filter.by_property("contract_id").equal(contract_id),
    )
    return res.total_count


def list_contract_ids(limit: int = 10000) -> list[str]:
    """Return distinct contract IDs currently present in the vector index."""
    coll = get_client().collections.get(_collection_name())
    res = coll.query.fetch_objects(limit=limit, return_properties=["contract_id"])
    out = []
    seen = set()
    for obj in res.objects:
        cid = str((obj.properties or {}).get("contract_id") or "")
        if cid and cid not in seen:
            seen.add(cid)
            out.append(cid)
    return out


def backfill_contract_metadata(limit: int = 1000) -> int:
    """Update existing vector objects with file_no and contract_number from SQLite."""
    ensure_collection()
    coll = get_client().collections.get(_collection_name())
    updated = 0
    after = None
    cache: dict[str, dict[str, str]] = {}
    while True:
        res = coll.query.fetch_objects(
            limit=limit,
            after=after,
            return_properties=["contract_id", "file_no", "contract_number"],
        )
        if not res.objects:
            break
        for obj in res.objects:
            props = obj.properties or {}
            cid = str(props.get("contract_id") or "")
            if not cid:
                continue
            if cid not in cache:
                cache[cid] = _contract_vector_metadata(cid)
            meta = cache[cid]
            if props.get("file_no") != meta["file_no"] or props.get("contract_number") != meta["contract_number"]:
                coll.data.update(uuid=obj.uuid, properties=meta)
                updated += 1
        after = res.objects[-1].uuid
    return updated


def _raw_extraction(row: dict | None) -> dict:
    raw = (row or {}).get("raw_extraction")
    if isinstance(raw, dict):
        return raw
    if isinstance(raw, str) and raw.strip():
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError:
            return {}
        return parsed if isinstance(parsed, dict) else {}
    return {}


def _contract_vector_metadata(contract_id: str) -> dict[str, str]:
    row = db.get_contract(contract_id) or {}
    raw = _raw_extraction(row)
    file_no = row.get("file_no") or raw.get("file_no") or ""
    contract_number = row.get("contract_number") or raw.get("contract_number") or ""
    return {
        "file_no": str(file_no or ""),
        "contract_number": str(contract_number or ""),
    }


def _chunk_properties(c: Chunk) -> dict:
    return {
        "text": c.content,
        "contract_id": c.contract_id,
        **_contract_vector_metadata(c.contract_id),
        "chunk_type": c.chunk_type,
        "page_start": c.page_start,
        "page_end": c.page_end,
        "section_path": " > ".join(c.section_path),
        # First-element layout bbox for the verify-popup highlight; Weaviate
        # NUMBER_ARRAY can't store None, so a bbox-less chunk maps to [].
        "bbox": list(c.bbox) if c.bbox else [],
        "img_path": c.img_path or "",
        "oversized": c.oversized,
    }


def ingest_chunks(chunks: list[Chunk], embedding=None) -> int:
    """Embed and upsert chunks. Returns the number ingested.

    Idempotent per contract: existing objects for each contract_id are deleted
    before insert, so re-running on the same PDF yields the same final state.
    """
    if not chunks:
        return 0
    ensure_collection()
    embedding = embedding or LLM().get_embedding_object()

    texts = [c.content for c in chunks]
    vectors = embedding.embed_documents(texts)

    # GUARD 1 — embedding silent-collapse (memory/embedding_pitfalls.md).
    if len(vectors) != len(chunks):
        raise RuntimeError(
            f"Embedding returned {len(vectors)} vectors for {len(chunks)} chunks — "
            "silent data loss. The Vertex gemini-embedding-2 endpoint collapses "
            "batched inputs to one vector; _PerItemGoogleEmbeddings must force "
            "batch_size=1 (see memory/embedding_pitfalls.md)."
        )

    contract_ids = {c.contract_id for c in chunks}
    for cid in contract_ids:
        delete_contract(cid)

    coll = get_client().collections.get(_collection_name())
    with coll.batch.dynamic() as batch:
        for c, vec in zip(chunks, vectors):
            batch.add_object(
                properties=_chunk_properties(c),
                uuid=uuid.uuid5(_UUID_NS, c.chunk_id),
                vector=vec,
            )

    failed = coll.batch.failed_objects
    if failed:
        raise RuntimeError(
            f"Weaviate batch insert failed for {len(failed)} object(s); "
            f"first error: {failed[0]}"
        )

    # GUARD 2 — confirm objects actually landed (count == chunk count per cid).
    for cid in contract_ids:
        expected = sum(1 for c in chunks if c.contract_id == cid)
        got = count_contract(cid)
        if got != expected:
            raise RuntimeError(
                f"Post-insert count mismatch for {cid}: expected {expected}, got {got}."
            )
    return len(chunks)


def get_langchain_store(embedding=None):
    """A langchain WeaviateVectorStore over this collection (for retrieval)."""
    from langchain_weaviate import WeaviateVectorStore

    embedding = embedding or LLM().get_embedding_object()
    return WeaviateVectorStore(
        client=get_client(),
        index_name=_collection_name(),
        text_key="text",
        embedding=embedding,
    )
