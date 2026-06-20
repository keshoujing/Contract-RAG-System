"""Run MinerU on a digital PDF and locate its ``content_list.json``.

MinerU is invoked as a subprocess (the ``mineru`` CLI shipped by the
``mineru[pipeline]`` dependency). For digital PDFs we use the txt method +
pipeline backend + ``ch`` language, validated in
``memory/digital_parsing_evaluation.md``.

Output layout (verified against ``_test_2026004_mineru/``):

    <out_dir>/<pdf_stem>/<method>/<pdf_stem>_content_list.json

The downstream chunker consumes this ``content_list.json`` directly — never the
markdown — per the digital-parsing evaluation decision.
"""
from __future__ import annotations

import json
import os
import pathlib
import shutil
import subprocess
import sysconfig

from contract_rag.config import load_config


def content_list_path(out_dir: str | pathlib.Path, pdf_stem: str, method: str) -> pathlib.Path:
    """Where MinerU writes the content_list for a given PDF + method."""
    return pathlib.Path(out_dir) / pdf_stem / method / f"{pdf_stem}_content_list.json"


def _mineru_command() -> str:
    """Resolve the MinerU CLI for the current Python environment.

    ``run_mineru`` may be called via ``.venv/bin/python`` from a shell whose
    PATH does not include ``.venv/bin``. Prefer the script installed next to the
    active interpreter, then fall back to PATH for globally installed setups.
    """
    script_name = "mineru.exe" if os.name == "nt" else "mineru"
    scripts_dir = sysconfig.get_path("scripts")
    if scripts_dir:
        candidate = pathlib.Path(scripts_dir) / script_name
        if candidate.exists():
            return str(candidate)
    return shutil.which("mineru") or "mineru"


def run_mineru(
    pdf_path: str | pathlib.Path,
    out_dir: str | pathlib.Path | None = None,
    *,
    method: str | None = None,
    backend: str | None = None,
    lang: str | None = None,
    reuse_existing: bool = False,
) -> pathlib.Path:
    """Parse ``pdf_path`` with MinerU and return the content_list.json path.

    Args:
        out_dir / method / backend / lang: default to config (txt / pipeline / ch).
        reuse_existing: if True and a content_list already exists at the
            expected path, skip the (~minutes-long) subprocess and return it.
            Handy for re-running verification without re-parsing.
    """
    cfg = load_config()
    pdf_path = pathlib.Path(pdf_path)
    if not pdf_path.exists():
        raise FileNotFoundError(f"PDF not found: {pdf_path}")

    out_dir = pathlib.Path(out_dir) if out_dir else cfg.paths.mineru_out
    method = method or cfg.mineru.method
    backend = backend or cfg.mineru.backend
    lang = lang or cfg.mineru.lang

    expected = content_list_path(out_dir, pdf_path.stem, method)
    if reuse_existing and expected.exists():
        return expected

    out_dir.mkdir(parents=True, exist_ok=True)
    cmd = [
        _mineru_command(),
        "-p", str(pdf_path),
        "-o", str(out_dir),
        "-m", method,
        "-b", backend,
        "-l", lang,
    ]
    # Stream MinerU's output to the console — the run takes minutes; the user
    # should see progress. check=True raises CalledProcessError on failure.
    subprocess.run(cmd, check=True)

    if not expected.exists():
        raise FileNotFoundError(
            f"MinerU completed but content_list.json was not found at {expected}. "
            f"Check the MinerU output under {out_dir}."
        )
    return expected


def _resolve_img_path(el: dict, base: pathlib.Path) -> dict:
    """Make an element's relative ``img_path`` absolute against ``base``.

    MinerU writes ``img_path`` as ``images/<hash>.jpg`` relative to the
    content_list's own directory. Downstream consumers (image enrichment reading
    the file, the front-end displaying it) need an absolute path. Returns a new
    dict; the original is not mutated.
    """
    img = el.get("img_path")
    if not img:
        return el
    p = pathlib.Path(img)
    if p.is_absolute():
        return el
    return {**el, "img_path": str(base / p)}


def load_content_list(path: str | pathlib.Path) -> list[dict]:
    """Load a MinerU content_list, resolving relative image paths to absolute."""
    path = pathlib.Path(path)
    elements = json.loads(path.read_text(encoding="utf-8"))
    base = path.parent
    return [_resolve_img_path(el, base) for el in elements]
