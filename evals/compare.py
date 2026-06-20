"""Pure aggregation / winner-selection / significance for the tuning experiment."""
from __future__ import annotations

import math


def _num(x, default: float = 0.0) -> float:
    """Coerce missing/NaN scores to a safe float so selection never crashes."""
    try:
        v = float(x)
    except (TypeError, ValueError):
        return default
    return default if math.isnan(v) else v


def mean_std(values: list[float]) -> tuple[float, float]:
    n = len(values)
    if n == 0:
        return 0.0, 0.0
    mean = sum(values) / n
    # population std (small fixed N; matches the spec's mean±std band)
    var = sum((v - mean) ** 2 for v in values) / n
    return mean, var ** 0.5


def aggregate_runs(runs: list[dict[str, float]]) -> dict[str, tuple[float, float]]:
    """[{metric: score}, ...] -> {metric: (mean, std)} across runs."""
    if not runs:
        return {}
    metrics = runs[0].keys()
    return {m: mean_std([r[m] for r in runs if m in r]) for m in metrics}


def pick_winner(
    scores_by_config: dict[str, dict[str, float]],
    *, metric: str, recall_floor: float,
    recall_metric: str = "context_recall",
) -> str:
    """Config with the highest `metric` among those whose recall >= floor."""
    eligible = {
        cfg: s for cfg, s in scores_by_config.items()
        if _num(s.get(recall_metric)) >= recall_floor
    }
    pool = eligible or scores_by_config  # if nothing clears the floor, fall back to all
    return max(pool, key=lambda cfg: _num(pool[cfg].get(metric)))


def is_significant(
    winner_runs: list[dict[str, float]],
    baseline_runs: list[dict[str, float]],
    *, metric: str,
) -> bool:
    """True iff winner's mean-std band sits entirely above baseline's mean+std."""
    wm, ws = mean_std([_num(r.get(metric)) for r in winner_runs])
    bm, bs = mean_std([_num(r.get(metric)) for r in baseline_runs])
    return (wm - ws) > (bm + bs)
