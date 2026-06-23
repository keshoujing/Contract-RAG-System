"""Portable Weaviate snapshot — export/import the BYO-vector corpus.

Because chunk vectors are computed client-side (gemini-embedding-2) and pushed
BYO, the whole collection can be dumped to a single parquet (text + metadata +
the 3072-d vector per object) and re-inserted into a fresh Weaviate **without any
embedding/LLM calls**. That makes the demo corpus portable and version-independent
(survives Weaviate upgrades) — ``docker compose up`` can seed-restore the dump
instead of re-running the expensive MinerU + bulk-embed ingestion of every PDF.

Note: query time still needs Vertex (the query is embedded live); this only
removes the *re-ingestion* cost, not retrieval's runtime dependency.

    export:  .venv/bin/python -m contract_rag.storage.snapshot export data/cuad/weaviate_snapshot.parquet
    import:  .venv/bin/python -m contract_rag.storage.snapshot import data/cuad/weaviate_snapshot.parquet
"""
from __future__ import annotations

import argparse
import json
import pathlib

import pyarrow as pa
import pyarrow.parquet as pq

from contract_rag.storage import vector_store


def _vector_values(vector) -> list[float]:
    """Weaviate may return the vector as a plain list or a named-vector dict."""
    if isinstance(vector, dict):
        return list(vector.get("default") or next(iter(vector.values()), []))
    return list(vector or [])


def _object_to_row(obj) -> dict:
    """Serialize one Weaviate object to a portable row (props as JSON string)."""
    return {
        "uuid": str(obj.uuid),
        "properties": json.dumps(obj.properties, ensure_ascii=False, default=str),
        "vector": _vector_values(obj.vector),
    }


def _row_to_insert(row: dict) -> dict:
    """Inverse of ``_object_to_row``: a row -> the kwargs for ``batch.add_object``."""
    return {
        "uuid": row["uuid"],
        "properties": json.loads(row["properties"]),
        "vector": list(row["vector"]),
    }


def _write_parquet(rows: list[dict], path: str | pathlib.Path) -> None:
    table = pa.table({
        "uuid": pa.array([r["uuid"] for r in rows], pa.string()),
        "properties": pa.array([r["properties"] for r in rows], pa.string()),
        "vector": pa.array([r["vector"] for r in rows], pa.list_(pa.float32())),
    })
    pathlib.Path(path).parent.mkdir(parents=True, exist_ok=True)
    pq.write_table(table, str(path))


def _read_parquet(path: str | pathlib.Path) -> list[dict]:
    return pq.read_table(str(path)).to_pylist()


def export_collection(path: str | pathlib.Path, *, batch_size: int = 200) -> int:
    """Dump every object (incl. its stored vector) of the collection to parquet.
    Returns the number of objects written."""
    client = vector_store.get_client()
    coll = client.collections.get(vector_store._collection_name())
    rows: list[dict] = []
    after = None
    while True:
        res = coll.query.fetch_objects(limit=batch_size, after=after, include_vector=True)
        if not res.objects:
            break
        rows.extend(_object_to_row(o) for o in res.objects)
        after = res.objects[-1].uuid
    _write_parquet(rows, path)
    return len(rows)


def import_collection(path: str | pathlib.Path, *, reset: bool = True) -> int:
    """Re-insert a parquet dump into Weaviate using the STORED vectors (no
    re-embedding). ``reset`` drops+recreates the collection first (idempotent
    restore). Returns the number of objects inserted."""
    rows = _read_parquet(path)
    if reset:
        vector_store.reset_collection()
    else:
        vector_store.ensure_collection()

    coll = vector_store.get_client().collections.get(vector_store._collection_name())
    with coll.batch.dynamic() as batch:
        for r in rows:
            payload = _row_to_insert(r)
            batch.add_object(
                properties=payload["properties"],
                uuid=payload["uuid"],
                vector=payload["vector"],
            )

    failed = coll.batch.failed_objects
    if failed:
        raise RuntimeError(f"snapshot import failed for {len(failed)} object(s); first: {failed[0]}")

    got = coll.aggregate.over_all(total_count=True).total_count
    if got != len(rows):
        raise RuntimeError(f"post-import count mismatch: expected {len(rows)}, got {got}")
    return len(rows)


def main() -> None:
    parser = argparse.ArgumentParser(description="Export/import the Weaviate BYO-vector corpus")
    parser.add_argument("action", choices=["export", "import"])
    parser.add_argument("path", help="parquet snapshot path")
    parser.add_argument("--no-reset", action="store_true", help="import: append instead of drop+recreate")
    args = parser.parse_args()
    try:
        if args.action == "export":
            n = export_collection(args.path)
            print(f"exported {n} objects -> {args.path}")
        else:
            n = import_collection(args.path, reset=not args.no_reset)
            print(f"imported {n} objects from {args.path}")
    finally:
        vector_store.close_client()


if __name__ == "__main__":
    main()
