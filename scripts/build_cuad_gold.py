"""Build a clause-retrieval golden set from CUAD's official annotations.

Zero Gemini: CUAD_v1.json already pairs each contract with expert-annotated clause
spans. We map its titles to our 100 ingested contract_ids, pick up to 2 answerable
*substantive* clause categories per contract (good for retrieval — not entity
fields like 'Document Name'), and emit {question, ground_truth(span),
expected_contract_ids}. Capped at 200 cases.

    .venv/bin/python -m scripts.build_cuad_gold
"""
from __future__ import annotations

import json
import pathlib
import re

_SRC = "data/cuad/raw/CUAD_v1/CUAD_v1.json"
_OUT = pathlib.Path("evals/dataset_cuad_gold.jsonl")
_PER_CONTRACT = 2
_CAP = 200
_MIN_SPAN = 20  # skip too-short spans (weak cosine signal)

# Substantive, retrieval-worthy clause categories (skip entity-ish ones like
# Document Name / Parties / Agreement Date which are SQL-ledger questions).
_WHITELIST = {
    "Governing Law", "Expiration Date", "Renewal Term",
    "Notice Period To Terminate Renewal", "Effective Date", "Cap On Liability",
    "Termination For Convenience", "Revenue/Profit Sharing", "Minimum Commitment",
    "Audit Rights", "Insurance", "Warranty Duration", "Post-Termination Services",
    "License Grant", "Exclusivity", "Ip Ownership Assignment", "Liquidated Damages",
    "Most Favored Nation", "Volume Restriction", "Price Restrictions",
    "Uncapped Liability", "Non-Compete", "Covenant Not To Sue", "Source Code Escrow",
}


def _safe_name(s: str, maxlen: int = 150) -> str:
    s = re.sub(r"\.pdf$", "", s, flags=re.IGNORECASE)
    s = re.sub(r"[^A-Za-z0-9._-]+", "_", s).strip("_")
    return s[:maxlen] or "contract"


def _category(qa: dict) -> str:
    m = re.search(r'related to "([^"]+)"', qa["question"])
    return m.group(1).strip() if m else ""


def _details(qa: dict) -> str:
    q = qa["question"]
    return q.split("Details:")[-1].strip() if "Details:" in q else q.strip()


def main() -> None:
    data = json.load(open(_SRC))["data"]
    my_ids = {p.stem for p in pathlib.Path("data/cuad/pdfs").glob("*.pdf")}
    by_safe = {_safe_name(d["title"]): d for d in data}

    cases = []
    for cid in sorted(my_ids):
        doc = by_safe.get(cid)
        if not doc:
            continue
        picked = 0
        for qa in doc["paragraphs"][0]["qas"]:
            if picked >= _PER_CONTRACT:
                break
            cat = _category(qa)
            ans = qa.get("answers") or []
            if cat not in _WHITELIST or not ans:
                continue
            span = ans[0]["text"].strip()
            if len(span) < _MIN_SPAN:
                continue
            cases.append({
                "id": f"{cid[:30]}__{cat.replace(' ', '_')}",
                "question": _details(qa),
                "ground_truth": span,
                "expected_contract_ids": [cid],
                "note": f"CUAD clause: {cat}",
            })
            picked += 1

    cases = cases[:_CAP]
    _OUT.write_text("\n".join(json.dumps(c, ensure_ascii=False) for c in cases) + "\n", encoding="utf-8")
    n_contracts = len({c["expected_contract_ids"][0] for c in cases})
    print(f"wrote {len(cases)} gold cases over {n_contracts} contracts -> {_OUT}")
    from collections import Counter
    cats = Counter(c["note"].split(": ")[1] for c in cases)
    print("clause categories:", dict(cats.most_common()))


if __name__ == "__main__":
    main()
