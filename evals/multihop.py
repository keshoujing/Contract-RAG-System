"""Scoring for the multi-hop / analytical eval (STUB, TDD).

The headline metric is *target grounding*: did the answer's evidence cite the
contract(s) the question is really about (e.g. the actual largest-amount
contract)? It's objective and needs no LLM judge — a wrong aggregation/multi-hop
lands on the wrong contract, so target_recall drops.
"""
from __future__ import annotations


def evidence_contract_ids(evidence: list[dict]) -> list[str]:
    """Distinct contract ids cited in the answer's evidence, in first-seen order."""
    seen: list[str] = []
    for item in evidence:
        cid = str(item.get("contract_id") or "").strip()
        if cid and cid not in seen:
            seen.append(cid)
    return seen


def target_recall(expected: list[str], returned: list[str]) -> float:
    """Fraction of the expected contracts the answer actually grounded in."""
    exp = [str(e).strip() for e in expected if str(e).strip()]
    if not exp:
        return 0.0
    ret = set(returned)
    return sum(1 for e in exp if e in ret) / len(exp)


def target_hit(expected: list[str], returned: list[str]) -> bool:
    """True iff every expected contract appears (strict all-or-nothing)."""
    return target_recall(expected, returned) == 1.0


def target_precision(expected: list[str], returned: list[str]) -> float:
    """Fraction of the *cited* contracts that were expected — penalizes the
    brute-force 'dump every contract' shortcut that inflates recall."""
    ret = list(dict.fromkeys(r for r in returned if str(r).strip()))
    if not ret:
        return 0.0
    exp = {str(e).strip() for e in expected if str(e).strip()}
    return sum(1 for r in ret if r in exp) / len(ret)


def target_f1(expected: list[str], returned: list[str]) -> float:
    """Harmonic mean of target recall and precision (0 if either is 0)."""
    p = target_precision(expected, returned)
    r = target_recall(expected, returned)
    return 0.0 if (p + r) == 0 else 2 * p * r / (p + r)
