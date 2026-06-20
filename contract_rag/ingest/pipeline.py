"""Synchronous ingestion orchestrator: PDF -> route -> parse -> chunk -> store.

Per-page routing (architecture A): each page is handled by its best engine and
the outputs are merged at the *element* level, then fed to one section-aware
chunker (so page boundaries — including the digital/scan seam — are transparent
and cross-page clauses are stitched together). See ``assembly.build_chunks`` and
``memory/ingestion_pipeline.md``.

  - digital / mixed / scan-with-text pages -> MinerU (whole-PDF run; its output
    for bare-scan pages is discarded in the merge);
  - bare-scan pages                         -> Gemini OCR (``ocr.ocr_scan_pages``);
  - embedded images on digital pages        -> Gemini Vision validity + describe
    (``image_enrichment``), dropping logos/signatures.

Even though the run is synchronous, each step writes its stage to the SQLite
``tasks`` table, so the write-points exist for a future async worker + API.

``contract_id`` is provided by the caller and is NOT derived from the filename
(decision 4 pitfall: the approval page is the authoritative source, built in a
later slice).
"""
from __future__ import annotations

import argparse
import logging
import pathlib
from dataclasses import dataclass

from contract_rag.config import load_config
from contract_rag.ingest.assembly import build_chunks, scan_page_numbers
from contract_rag.ingest.image_enrichment import gemini_image_verdict
from contract_rag.ingest.mineru_runner import load_content_list, run_mineru
from contract_rag.ingest.ocr import ocr_scan_pages
from contract_rag.ingest.router import BLOCKING_CLASSES, class_counts, route_pdf
from contract_rag.storage import db
from contract_rag.storage.vector_store import ingest_chunks

logger = logging.getLogger(__name__)


@dataclass
class IngestResult:
    task_id: str
    contract_id: str
    n_pages: int
    n_chunks: int
    page_classes: dict[str, int]
    content_list_path: str | None  # None when the doc is fully scanned (no MinerU run)


def _page_route_label(page_class: str) -> str:
    """Which engine processed a page, for the SQLite `pages` table."""
    return "ocr" if page_class in BLOCKING_CLASSES else "mineru"


def ingest_contract(
    pdf_path: str | pathlib.Path,
    contract_id: str,
    *,
    reuse_mineru: bool = False,
    out_dir: str | pathlib.Path | None = None,
) -> IngestResult:
    """Ingest one contract PDF end-to-end (digital + scanned pages).

    Args:
        contract_id: caller-supplied stable id (NOT the filename).
        reuse_mineru: skip the MinerU subprocess if its output already exists.
    """
    pdf_path = pathlib.Path(pdf_path)
    cfg = load_config()
    db.init_db()
    task_id = db.create_task(contract_id=contract_id)
    logger.info("ingest start: task=%s contract=%s pdf=%s", task_id, contract_id, pdf_path.name)

    try:
        # 1. Route every page (fast fitz metadata).
        db.update_task_stage(task_id, "tagging")
        routes = route_pdf(pdf_path)
        counts = class_counts(routes)
        db.insert_pages(
            contract_id,
            [
                {
                    "page_no": r.page_no,
                    "page_type": None,
                    "route": _page_route_label(r.page_class),
                    "avg_confidence": None,
                }
                for r in routes
            ],
        )
        logger.info("routed %d pages: %s", len(routes), counts)

        scan_pages = scan_page_numbers(routes)
        needs_mineru = any(r.page_class not in BLOCKING_CLASSES for r in routes)

        # 2. Digital/mixed/scan-with-text pages -> MinerU (skip if fully scanned).
        cl_path: pathlib.Path | None = None
        mineru_elements: list[dict] = []
        if needs_mineru:
            db.update_task_stage(task_id, "parsing")
            cl_path = run_mineru(pdf_path, out_dir=out_dir, reuse_existing=reuse_mineru)
            mineru_elements = load_content_list(cl_path)
            logger.info("MinerU produced %d elements -> %s", len(mineru_elements), cl_path)

        # 3. Bare-scan pages -> Gemini OCR (same element shape as MinerU).
        ocr_by_page: dict[int, list[dict]] = {}
        if scan_pages:
            db.update_task_stage(task_id, "ocr_processing")
            ocr_by_page = ocr_scan_pages(pdf_path, scan_pages)
            logger.info("OCR'd %d scan page(s)", len(scan_pages))

        # 4. Merge (element level) + enrich embedded images + chunk (one pass).
        db.update_task_stage(task_id, "chunking")
        chunks = build_chunks(
            mineru_elements,
            ocr_by_page,
            routes,
            contract_id=contract_id,
            classify=gemini_image_verdict,
            soft_target=cfg.chunking.soft_target,
            hard_cap=cfg.chunking.hard_cap,
            overlap=cfg.chunking.overlap,
        )
        logger.info("assembled %d chunks", len(chunks))

        # 5. Embed + store (guards against the silent-collapse bug internally).
        db.update_task_stage(task_id, "embedding")
        n = ingest_chunks(chunks)

        # 6. Upsert contract row + finish. (Approval-page fields filled later.)
        db.upsert_contract(contract_id, status="active")
        db.update_task_stage(task_id, "done", status="done")
        logger.info("ingest done: task=%s contract=%s chunks=%d", task_id, contract_id, n)

        return IngestResult(
            task_id=task_id,
            contract_id=contract_id,
            n_pages=len(routes),
            n_chunks=n,
            page_classes=counts,
            content_list_path=str(cl_path) if cl_path else None,
        )
    except Exception as e:  # noqa: BLE001 - record failure on the task, then re-raise
        db.update_task_stage(task_id, "failed", status="failed", error_message=str(e))
        logger.exception("ingest failed: task=%s contract=%s", task_id, contract_id)
        raise


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    parser = argparse.ArgumentParser(description="Ingest a contract PDF end-to-end")
    parser.add_argument("pdf", help="path to the contract PDF")
    parser.add_argument("--contract-id", required=True, help="stable contract id (NOT the filename)")
    parser.add_argument("--reuse-mineru", action="store_true", help="reuse existing MinerU output if present")
    args = parser.parse_args()

    result = ingest_contract(args.pdf, args.contract_id, reuse_mineru=args.reuse_mineru)
    print(result)


if __name__ == "__main__":
    main()
