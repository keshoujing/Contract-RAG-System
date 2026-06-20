import math

from evals.compare import mean_std, aggregate_runs, pick_winner, is_significant


def test_mean_std():
    m, s = mean_std([0.8, 0.9, 0.7])
    assert abs(m - 0.8) < 1e-9
    assert abs(s - math.sqrt(((0.0)**2 + 0.1**2 + 0.1**2) / 3)) < 1e-9


def test_aggregate_runs():
    runs = [{"a": 0.8, "b": 0.5}, {"a": 0.6, "b": 0.5}]
    agg = aggregate_runs(runs)
    assert abs(agg["a"][0] - 0.7) < 1e-9
    assert abs(agg["b"][0] - 0.5) < 1e-9


def test_pick_winner_respects_recall_floor():
    scores = {
        "cfgA": {"answer_correctness": 0.50, "context_recall": 0.90},
        "cfgB": {"answer_correctness": 0.60, "context_recall": 0.70},  # best correctness but recall too low
        "cfgC": {"answer_correctness": 0.55, "context_recall": 0.85},
    }
    # floor excludes cfgB (0.70 < 0.85)
    assert pick_winner(scores, metric="answer_correctness", recall_floor=0.85) == "cfgC"


def test_is_significant_non_overlapping():
    winner = [{"answer_correctness": 0.70}, {"answer_correctness": 0.72}, {"answer_correctness": 0.71}]
    baseline = [{"answer_correctness": 0.44}, {"answer_correctness": 0.45}, {"answer_correctness": 0.43}]
    assert is_significant(winner, baseline, metric="answer_correctness") is True


def test_is_significant_overlapping():
    winner = [{"answer_correctness": 0.50}, {"answer_correctness": 0.46}, {"answer_correctness": 0.48}]
    baseline = [{"answer_correctness": 0.44}, {"answer_correctness": 0.49}, {"answer_correctness": 0.47}]
    assert is_significant(winner, baseline, metric="answer_correctness") is False
