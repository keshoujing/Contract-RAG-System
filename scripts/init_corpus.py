"""Container startup hook: load the demo corpus, or start empty.

Driven by the ``DEMO_DATA`` env var (set by ``run.sh`` / docker-compose):
  - ``1`` (default): import the committed Weaviate snapshot (stored vectors, no
    Vertex calls) so the 100-contract demo is ready.
  - ``0``: reset the collection to empty (user uploads their own contracts).

Retries until Weaviate is reachable, so it tolerates the DB still booting.
"""
from __future__ import annotations

import os
import pathlib
import shutil
import time

from contract_rag.storage import snapshot, vector_store

_SNAPSHOT = "data/cuad/weaviate_snapshot.parquet"
_PDF_DIR = pathlib.Path("data/cuad/pdfs")
_RETRIES = 60
_DELAY_S = 2


def _populate_demo_storage() -> int:
    """Put each demo PDF at ``storage/{contract_id}/signed.pdf`` so the verify
    popup can render/highlight pages.

    The CUAD corpus is ingested directly (Weaviate + ledger) and never goes
    through the upload flow that normally fills ``storage/``; without this the
    page/file endpoints 404. contract_id == the PDF stem.
    """
    from contract_rag.api import storage_paths as sp

    copied = 0
    for pdf in _PDF_DIR.glob("*.pdf"):
        dst = sp.signed_pdf(sp.contract_dir(pdf.stem))
        if not dst.exists():
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(pdf, dst)
            copied += 1
    return copied


def main() -> None:
    demo = os.getenv("DEMO_DATA", "1") != "0"
    last_err: Exception | None = None
    for _ in range(_RETRIES):
        try:
            if demo:
                n = snapshot.import_collection(_SNAPSHOT)
                pdfs = _populate_demo_storage()
                print(f"[init] demo corpus loaded: {n} objects, {pdfs} PDFs staged for highlight", flush=True)
            else:
                vector_store.reset_collection()
                print("[init] empty corpus (Weaviate collection reset)", flush=True)
            return
        except Exception as e:  # noqa: BLE001 — Weaviate may still be booting
            last_err = e
            time.sleep(_DELAY_S)
    raise SystemExit(f"[init] Weaviate not reachable after {_RETRIES} tries: {last_err}")


if __name__ == "__main__":
    main()
