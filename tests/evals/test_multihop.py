"""Multi-hop eval scoring (pure): did the answer ground in the right contract(s)?"""
from evals import multihop as mh


def test_evidence_contract_ids_dedups_and_keeps_order():
    evidence = [
        {"kind": "record", "contract_id": "B"},
        {"kind": "clause", "contract_id": "A"},
        {"kind": "clause", "contract_id": "B"},
        {"kind": "record", "contract_id": ""},
    ]
    assert mh.evidence_contract_ids(evidence) == ["B", "A"]


def test_target_recall_full_partial_none():
    assert mh.target_recall(["A", "B"], ["A", "B", "C"]) == 1.0
    assert mh.target_recall(["A", "B"], ["A", "Z"]) == 0.5
    assert mh.target_recall(["A", "B"], ["X"]) == 0.0


def test_target_recall_empty_expected_is_zero():
    assert mh.target_recall([], ["A"]) == 0.0


def test_target_hit_requires_all_expected():
    assert mh.target_hit(["A", "B"], ["A", "B", "C"]) is True
    assert mh.target_hit(["A", "B"], ["A"]) is False


def test_target_precision_penalizes_over_returning():
    assert mh.target_precision(["A", "B"], ["A", "B"]) == 1.0
    assert mh.target_precision(["A"], ["A", "B", "C"]) == 1 / 3   # dumped 3, only 1 right
    assert mh.target_precision(["A"], ["X"]) == 0.0
    assert mh.target_precision(["A"], []) == 0.0


def test_target_f1_balances_recall_and_precision():
    assert mh.target_f1(["A", "B"], ["A", "B"]) == 1.0
    # recall 1.0, precision 1/3 -> f1 0.5
    assert mh.target_f1(["A"], ["A", "B", "C"]) == 0.5
    assert mh.target_f1(["A"], []) == 0.0
