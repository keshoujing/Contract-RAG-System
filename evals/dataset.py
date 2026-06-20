"""Gold evaluation dataset loader (pure, no network)."""
from __future__ import annotations

import json
import pathlib
from dataclasses import dataclass

_REQUIRED = ("question", "ground_truth", "contract_id")


@dataclass(frozen=True)
class GoldCase:
    question: str
    ground_truth: str
    contract_id: str
    note: str = ""


def load_dataset(path: str | pathlib.Path) -> list[GoldCase]:
    cases: list[GoldCase] = []
    for lineno, line in enumerate(pathlib.Path(path).read_text(encoding="utf-8").splitlines(), 1):
        line = line.strip()
        if not line:
            continue
        row = json.loads(line)
        missing = [f for f in _REQUIRED if not row.get(f)]
        if missing:
            raise ValueError(f"line {lineno}: missing required field(s): {', '.join(missing)}")
        cases.append(GoldCase(
            question=row["question"],
            ground_truth=row["ground_truth"],
            contract_id=row["contract_id"],
            note=row.get("note", ""),
        ))
    return cases
