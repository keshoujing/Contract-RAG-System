"""Batch-ingest the CUAD demo corpus into Weaviate + the SQLite ledger.

For each PDF in ``data/cuad/pdfs/``:
  1. ingest_contract  -> MinerU parse -> chunk -> embed -> Weaviate (+ active row)
  2. extract_cuad_metadata over the PDF's own text -> ledger fields
  3. upsert_contract  -> counterparty / amount / dates / contract_type / summary

Resumable (skips contracts already in Weaviate) and ``--limit``-able, so the slow
full run can be done in chunks or restarted after an interruption. One bad PDF is
logged and skipped, never aborting the batch. Timing is printed per contract.

Run (live: MinerU + Gemini + Weaviate):
    .venv/bin/python -m scripts.ingest_cuad --limit 5     # try a few
    .venv/bin/python -m scripts.ingest_cuad               # the whole corpus
"""
from __future__ import annotations

import argparse
import pathlib
import time

import fitz

from contract_rag.ingest.cuad_metadata import contract_type_from_filename, extract_cuad_metadata
from contract_rag.ingest.pipeline import ingest_contract
from contract_rag.storage import db, vector_store

_PDF_DIR = pathlib.Path("data/cuad/pdfs")
_TEXT_CHARS = 8000


def _already_done(cid: str) -> bool:
    try:
        return db.contract_exists(cid) and vector_store.count_contract(cid) > 0
    except Exception:
        return False


def _pdf_text(pdf: pathlib.Path) -> str:
    with fitz.open(pdf) as doc:
        return "".join(page.get_text() for page in doc)[:_TEXT_CHARS]


def main() -> None:
    ap = argparse.ArgumentParser(description="Batch-ingest the CUAD demo corpus")
    ap.add_argument("--limit", type=int, default=None, help="max contracts to ingest this run")
    ap.add_argument("--force", action="store_true", help="re-ingest even if already present")
    args = ap.parse_args()

    db.init_db()
    pdfs = sorted(_PDF_DIR.glob("*.pdf"))
    done = failed = skipped = total_chunks = 0
    t0 = time.time()

    for pdf in pdfs:
        if args.limit and done >= args.limit:
            break
        cid = pdf.stem
        if not args.force and _already_done(cid):
            skipped += 1
            continue
        ts = time.time()
        try:
            res = ingest_contract(pdf, cid)
            meta = extract_cuad_metadata(_pdf_text(pdf))
            ctype = contract_type_from_filename(cid)
            db.upsert_contract(
                cid, status="active", contract_type=ctype, file_no=cid,
                raw_extraction={**meta, "contract_type": ctype, "source": "cuad"},
                **meta,
            )
            total_chunks += res.n_chunks
            done += 1
            print(f"[{done:>3}] {cid[:48]:<48} chunks={res.n_chunks:>3} "
                  f"type={ctype:<14} party={str(meta.get('counterparty'))[:20]:<20} "
                  f"{time.time() - ts:5.1f}s")
        except Exception as e:  # noqa: BLE001 — one bad PDF must not abort the batch
            failed += 1
            print(f"[ERR] {cid[:48]:<48} {type(e).__name__}: {str(e)[:70]}")

    dt = time.time() - t0
    print("-" * 80)
    per = f" ({dt / done:.1f}s/contract)" if done else ""
    print(f"done={done}  skipped(resume)={skipped}  failed={failed}  "
          f"total_chunks={total_chunks}  elapsed={dt:.0f}s{per}")
    vector_store.close_client()


if __name__ == "__main__":
    main()
