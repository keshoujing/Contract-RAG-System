"""Eval report builder + writer (pure logic; I/O confined to write_report)."""
from __future__ import annotations

import json
import pathlib
from datetime import datetime, timezone


def build_report(*, dataset: str, contract_id: str, n_cases: int, scores: dict) -> dict:
    return {
        "timestamp": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "dataset": dataset,
        "contract_id": contract_id,
        "n_cases": n_cases,
        "scores": {k: round(float(v), 4) for k, v in scores.items()},
    }


def write_report(report: dict, *, out_dir: str | pathlib.Path) -> pathlib.Path:
    out_dir = pathlib.Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%d-%H%M%S")
    out = out_dir / f"{stamp}.json"
    out.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    return out
