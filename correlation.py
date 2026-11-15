"""Correlation and lagged correlation between the topics of one request.

The plot panel's "Compare variables" view sends two or more series that share
one interval grid (``x`` is the interval index, so ``x + 1`` is the next
interval) and gets back, for every pair:

* Pearson r and Spearman rho over the intervals both series have,
* a p-value that accounts for autocorrelation: two smooth series share far
  fewer independent values than intervals, so with lag-1 autocorrelations
  ``r1a`` and ``r1b`` the effective sample size is
  ``n (1 - r1a r1b) / (1 + r1a r1b)`` (Bretherton et al. 1999),
* the cross-correlation for lags ``-max_lag .. max_lag``: at lag ``k`` the
  value of A at interval ``t`` is paired with B at ``t + k``, so a peak at a
  positive ``k`` means "A leads B by k intervals".

No check is made whether a pair makes physical sense (e.g. wind direction
against temperature): the user decides what is worth comparing.
"""

from __future__ import annotations

import math
from itertools import combinations
from typing import Any, Sequence

import numpy as np
from scipy import stats

from src.task import lag1_autocorrelation

MAX_SERIES: int = 8
"""Most series accepted in one request (28 pairs)."""

MAX_POINTS: int = 40_000
"""Most values per series (100 years of daily values)."""

MAX_LAG: int = 60
"""Largest lag (in intervals) that can be requested."""

MIN_PAIRS: int = 5
"""Fewest matched intervals for which a correlation is reported."""


class CorrelationError(ValueError):
    """Raised when the posted series cannot be correlated."""


def _round(value: float | None, digits: int = 4) -> float | None:
    if value is None:
        return None
    value = float(value)
    return round(value, digits) if math.isfinite(value) else None


def _clean(series: Any) -> tuple[str, dict[int, float]]:
    """``{"name", "x", "values"}`` -> name and ``{interval index: value}``."""
    if not isinstance(series, dict):
        raise CorrelationError("Each series must be an object with name, x and values.")
    name = str(series.get("name") or "")
    xs, ys = series.get("x"), series.get("values")
    if not isinstance(xs, (list, tuple)) or not isinstance(ys, (list, tuple)):
        raise CorrelationError(f"Series {name!r}: x and values must be lists.")
    if len(xs) != len(ys):
        raise CorrelationError(f"Series {name!r}: x and values must have the same length.")
    if len(xs) > MAX_POINTS:
        raise CorrelationError(f"Series {name!r}: at most {MAX_POINTS} values.")
    out: dict[int, float] = {}
    for raw_x, raw_y in zip(xs, ys):
        if raw_y is None or raw_x is None:
            continue
        if isinstance(raw_x, bool) or isinstance(raw_y, bool):
            raise CorrelationError(f"Series {name!r}: x and values must be numbers.")
        try:
            fx, fy = float(raw_x), float(raw_y)
        except (TypeError, ValueError) as exc:
            raise CorrelationError(f"Series {name!r}: x and values must be numbers.") from exc
        if not (math.isfinite(fx) and math.isfinite(fy)):
            continue
        if fx != int(fx):
            raise CorrelationError(f"Series {name!r}: x must be whole interval indices.")
        out[int(fx)] = fy
    return name, out


def _paired(a: dict[int, float], b: dict[int, float], lag: int = 0) -> tuple[np.ndarray, np.ndarray]:
    """Values of A at ``t`` and B at ``t + lag`` for every ``t`` both have."""
    keys = sorted(t for t in a if t + lag in b)
    return (
        np.fromiter((a[t] for t in keys), dtype=np.float64, count=len(keys)),
        np.fromiter((b[t + lag] for t in keys), dtype=np.float64, count=len(keys)),
    )


def _pearson(x: np.ndarray, y: np.ndarray) -> float | None:
    if x.size < MIN_PAIRS or np.ptp(x) == 0 or np.ptp(y) == 0:
        return None
    return float(np.corrcoef(x, y)[0, 1])


def _p_from_r(r: float, n_eff: float) -> float | None:
    if n_eff <= 2 or not math.isfinite(r):
        return None
    if abs(r) >= 1:
        return 0.0
    t_value = r * math.sqrt((n_eff - 2) / (1 - r * r))
    return float(2 * stats.t.sf(abs(t_value), n_eff - 2))


def _pair(name_a: str, a: dict[int, float], name_b: str, b: dict[int, float], max_lag: int) -> dict[str, Any]:
    x, y = _paired(a, b)
    n = int(x.size)
    result: dict[str, Any] = {"a": name_a, "b": name_b, "n": n}
    r = _pearson(x, y)
    if r is None:
        result.update(
            available=False,
            error=f"Fewer than {MIN_PAIRS} intervals with values of both series, or one of them is constant.",
            lags=[],
        )
        return result
    r1a = lag1_autocorrelation(x.tolist())
    r1b = lag1_autocorrelation(y.tolist())
    product = max(r1a * r1b, 0.0)
    n_eff = max(3.0, n * (1 - product) / (1 + product)) if product < 0.99 else 3.0
    rho, p_rho_plain = stats.spearmanr(x, y)
    p_plain = _p_from_r(r, n)
    p_adj = _p_from_r(r, n_eff)
    p_rho = _p_from_r(float(rho), n_eff)
    slope, intercept = np.polyfit(x, y, 1)

    lags: list[dict[str, Any]] = []
    for k in range(-max_lag, max_lag + 1):
        lx, ly = _paired(a, b, k)
        rk = _pearson(lx, ly)
        lags.append({"lag": k, "r": _round(rk), "n": int(lx.size)})
    usable = [entry for entry in lags if entry["r"] is not None]
    best = max(usable, key=lambda e: abs(e["r"])) if usable else None

    result.update(
        available=True,
        pearson=_round(r),
        spearman=_round(float(rho)),
        r_squared=_round(r * r),
        p_value=_round(p_adj),
        p_value_unadjusted=_round(p_plain),
        spearman_p_value=_round(p_rho),
        spearman_p_value_unadjusted=_round(float(p_rho_plain)),
        autocorrelation=[_round(r1a, 3), _round(r1b, 3)],
        effective_n=_round(n_eff, 1),
        significant=bool(p_adj is not None and p_adj < 0.05),
        slope=_round(float(slope), 6),
        intercept=_round(float(intercept), 6),
        lags=lags,
        best_lag=best,
        # The rough 95 % band of a lagged r under "no relation" (white-noise approximation
        # with the effective sample size); a guide for the lag chart, not a test.
        lag_band=_round(1.96 / math.sqrt(n_eff)),
    )
    return result


def correlate(series: Sequence[Any], max_lag: int = 12) -> dict[str, Any]:
    """Correlate every pair of the given series (see the module docstring).

    :param series: ``[{"name": str, "x": [interval index], "values": [...]}, ...]``;
        ``None`` marks a missing value. Two to :data:`MAX_SERIES` series.
    :param max_lag: Lags ``-max_lag .. max_lag`` (in intervals) for the
        cross-correlation; 0 to :data:`MAX_LAG`.
    :return: ``{"pairs": [...], "max_lag": int}`` with one entry per pair in
        input order (A before B).
    :raises CorrelationError: For malformed input.
    """
    if not isinstance(series, (list, tuple)):
        raise CorrelationError("series must be a list.")
    if not 2 <= len(series) <= MAX_SERIES:
        raise CorrelationError(f"Between 2 and {MAX_SERIES} series are needed.")
    if isinstance(max_lag, bool):
        raise CorrelationError("max_lag must be a whole number.")
    try:
        max_lag = int(max_lag)
    except (TypeError, ValueError) as exc:
        raise CorrelationError("max_lag must be a whole number.") from exc
    if not 0 <= max_lag <= MAX_LAG:
        raise CorrelationError(f"max_lag must be between 0 and {MAX_LAG}.")
    cleaned = [_clean(s) for s in series]
    pairs = [
        _pair(name_a, a, name_b, b, max_lag)
        for (name_a, a), (name_b, b) in combinations(cleaned, 2)
    ]
    return {"pairs": pairs, "max_lag": max_lag}


__all__ = ["CorrelationError", "correlate"]
