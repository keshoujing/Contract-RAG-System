"""Filesystem layout for archived contracts.

Uploads land under ``{storage}/_uploads/{task_id}/`` before the contract_id is
known (it comes from approval extraction). On confirm, the directory is promoted
to ``{storage}/{contract_id}/``. See design spec.
"""
from __future__ import annotations

import pathlib
import shutil

from contract_rag.config import load_config

_UPLOADS = "_uploads"


def _storage_root() -> pathlib.Path:
    return load_config().paths.storage_dir


def upload_dir(task_id: str) -> pathlib.Path:
    return _storage_root() / _UPLOADS / task_id


def contract_dir(contract_id: str) -> pathlib.Path:
    return _storage_root() / contract_id


def signed_pdf(base: pathlib.Path) -> pathlib.Path:
    return base / "signed.pdf"


def pages_dir(base: pathlib.Path) -> pathlib.Path:
    return base / "pages"


def page_png(base: pathlib.Path, page_no: int) -> pathlib.Path:
    """Path to a 1-indexed page PNG. Rejects non-positive indices (traversal guard)."""
    if not isinstance(page_no, int) or page_no < 1:
        raise ValueError(f"invalid page_no: {page_no!r}")
    return pages_dir(base) / f"{page_no}.png"


def promote_upload(task_id: str, contract_id: str) -> pathlib.Path:
    """Move the upload dir to the contract dir, replacing any existing one."""
    src = upload_dir(task_id)
    dst = contract_dir(contract_id)
    if dst.exists():
        shutil.rmtree(dst)
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(src), str(dst))
    return dst


def remove_contract_dir(contract_id: str) -> None:
    d = contract_dir(contract_id)
    if d.exists():
        shutil.rmtree(d)
