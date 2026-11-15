"""Run the analysis tools on a series chosen in the plot panel.

The plot panel below the map can reduce a topic's time series to a new
series, for example the January mean of every year. This module runs the
existing tools from :mod:`src.task` on such a series without changing them,
so the panel shows the same statistics as the main task output.

Input and output are JSON-friendly, see :func:`analyze_series`.
"""

from __future__ import annotations

import math
from typing import Any, Sequence

import torch

from scipy import stats

from src.task import (
    LinearRegression,
    TTest,
    effective_sample_size,
    get_available_tools,
    hamed_rao_variance_factor,
    lag1_autocorrelation,
    mann_kendall_test,
    pettitt_test,
    remove_seasonal_cycle,
    theil_sen,
)

MAX_POINTS: int = 40_000
"""Largest series accepted from the frontend (100 years of daily values; all tools take ~5 s)."""

MAX_GROUPS: int = 500
"""Most groups (e.g. one per year) accepted in one call to :func:`analyze_groups`."""


class AnalysisError(ValueError):
    """Raised when the posted series cannot be analysed."""


def _round(value: float, digits: int = 4) -> float | None:
    """Round a finite number for JSON; encode NaN and infinity as ``None``."""
    value = float(value)
    return round(value, digits) if math.isfinite(value) else None


def _round_sig(value: float, digits: int = 5) -> float | None:
    """Round to significant digits, so tiny slopes (e.g. 0.00003 °C/day) survive."""
    value = float(value)
    if not math.isfinite(value):
        return None
    if value == 0:
        return 0.0
    return round(value, max(digits - 1 - int(math.floor(math.log10(abs(value)))), 0))


def _clean_series(x: Sequence[Any], values: Sequence[Any]) -> tuple[list[float], list[float]]:
    """Validate the posted series and drop pairs with a missing value.

    :raises AnalysisError: If the lists differ in length, are too long, or
        contain values that are not numbers.
    """
    if not isinstance(x, (list, tuple)) or not isinstance(values, (list, tuple)):
        raise AnalysisError("x and values must be lists.")
    if len(x) != len(values):
        raise AnalysisError("x and values must have the same length.")
    if len(x) > MAX_POINTS:
        raise AnalysisError(f"At most {MAX_POINTS} points can be analysed.")
    xs: list[float] = []
    ys: list[float] = []
    for raw_x, raw_y in zip(x, values):
        if raw_y is None:
            continue
        if isinstance(raw_x, bool) or isinstance(raw_y, bool):
            raise AnalysisError("x and values must be numbers.")
        try:
            fx, fy = float(raw_x), float(raw_y)
        except (TypeError, ValueError) as exc:
            raise AnalysisError("x and values must be numbers.") from exc
        if math.isfinite(fx) and math.isfinite(fy):
            xs.append(fx)
            ys.append(fy)
    return xs, ys


def _linear_regression(
    xs: list[float], ys: list[float], season_length: float | None = None
) -> dict[str, Any]:
    """Slope per x unit, intercept, fit quality and slope test.

    The p-value accounts for autocorrelation of the residuals: with lag-1
    autocorrelation ``r1`` the series holds only ``n_eff = n(1-r1)/(1+r1)``
    independent values (Santer et al. 2000), so the slope's standard error
    is widened accordingly. Without this, ten years of daily temperatures
    (r1 ≈ 0.8) would call almost any wiggle "significant".
    ``p_value_unadjusted`` keeps the textbook value.
    """
    if len(xs) < 3 or len(set(xs)) < 2:
        return {
            "available": False,
            "error": "At least three values at different x are required.",
            "observations": len(xs),
        }
    trend = LinearRegression().analyze_trend(xs, ys)
    order = sorted(range(len(xs)), key=xs.__getitem__)
    residuals = [ys[i] - (trend.slope * xs[i] + trend.intercept) for i in order]
    n = len(xs)
    # The seasonal cycle is not noise around the trend: estimate the
    # autocorrelation without it.
    r1 = lag1_autocorrelation(remove_seasonal_cycle([xs[i] for i in order], residuals, season_length))
    n_eff = effective_sample_size(n, r1)
    p_value = trend.p_value
    low, high = trend.confidence_interval
    if n_eff < n and n_eff > 2 and trend.standard_error > 0:
        stderr = trend.standard_error * math.sqrt((n - 2) / (n_eff - 2))
        t_value = trend.slope / stderr
        p_value = float(2 * stats.t.sf(abs(t_value), n_eff - 2))
        margin = float(stats.t.ppf(0.975, n_eff - 2)) * stderr
        low, high = trend.slope - margin, trend.slope + margin
    return {
        "available": True,
        "slope": _round_sig(trend.slope),
        "intercept": _round(trend.intercept),
        "r_squared": _round(trend.r_value**2),
        "p_value": _round(p_value),
        "p_value_unadjusted": _round(trend.p_value),
        "autocorrelation": _round(r1, 3),
        "effective_n": _round(n_eff, 1),
        "confidence_interval": [_round_sig(low), _round_sig(high)],
        "significant": bool(p_value < 0.05),
        "trend_line": [_round(trend.slope * x + trend.intercept, 3) for x in xs],
        "observations": trend.observations,
    }


def _t_test(
    xs: list[float], ys: list[float], season_length: float | None = None
) -> dict[str, Any]:
    """Welch t-test of the first half against the second half of the series."""
    if len(ys) < 4:
        return {
            "available": False,
            "error": "At least four values are required to compare two halves.",
            "observations": len(ys),
        }
    statistic, p_value = TTest().process(torch.tensor(xs), torch.tensor(ys))
    middle = len(ys) // 2
    t_value = float(statistic.item())
    p_plain = float(p_value.item())
    # Autocorrelated values (and the seasonal cycle) carry less independent
    # information than their count: scale t by sqrt(n_eff / n).
    n = len(ys)
    residual = remove_seasonal_cycle(xs, ys, season_length)
    early_level = float(sum(residual[:middle]) / middle)
    late_level = float(sum(residual[middle:]) / (n - middle))
    residual = [v - (early_level if i < middle else late_level) for i, v in enumerate(residual)]
    n_eff = effective_sample_size(n, lag1_autocorrelation(residual))
    p_adjusted = p_plain
    if n_eff < n and math.isfinite(t_value):
        t_value *= math.sqrt(n_eff / n)
        p_adjusted = float(2 * stats.t.sf(abs(t_value), max(n_eff - 2, 1)))
    return {
        "available": True,
        "t_statistic": _round(t_value),
        "p_value": _round(p_adjusted),
        "p_value_unadjusted": _round(p_plain),
        "effective_n": _round(n_eff, 1),
        "significant": bool(p_adjusted < 0.05),
        "early_mean": _round(sum(ys[:middle]) / middle, 3),
        "late_mean": _round(sum(ys[middle:]) / (len(ys) - middle), 3),
        "split_x": xs[middle],
        "observations": len(ys),
    }


def _mann_kendall(
    xs: list[float], ys: list[float], season_length: float | None = None
) -> dict[str, Any]:
    """Mann-Kendall test for a monotonic trend.

    ``trend``, ``p_value`` and ``significant`` use the variance correction of
    Hamed & Rao (1998) for autocorrelated data; ``p_value_unadjusted`` is the
    classic test, which assumes independent values.
    """
    if len(ys) < 3:
        return {
            "available": False,
            "error": "At least three values are required for the Mann-Kendall test.",
            "observations": len(ys),
        }
    if len(set(xs)) != len(xs):
        return {
            "available": False,
            "error": "Every value needs its own x for the Mann-Kendall test.",
            "observations": len(ys),
        }
    result = mann_kendall_test(xs, ys)
    factor = hamed_rao_variance_factor(xs, list(remove_seasonal_cycle(xs, ys, season_length)))
    p_value, z_value = result.p_value, result.z_statistic
    if factor != 1.0 and result.variance > 0:
        z_value = result.z_statistic / math.sqrt(factor)
        p_value = float(2 * stats.norm.sf(abs(z_value)))
    significant = p_value < result.alpha
    trend = (
        ("increasing" if result.s_statistic > 0 else "decreasing")
        if significant and result.s_statistic != 0
        else "no significant trend"
    )
    return {
        "available": True,
        "trend": trend,
        "p_value": _round(p_value),
        "p_value_unadjusted": _round(result.p_value),
        "variance_factor": _round(factor, 3),
        "tau": _round(result.tau),
        "z_statistic": _round(z_value),
        "s_statistic": result.s_statistic,
        "significant": bool(significant),
        "observations": result.observations,
    }


def _sens_slope(
    xs: list[float], ys: list[float], season_length: float | None = None
) -> dict[str, Any]:
    """Theil-Sen slope with its 95 % interval; significant if the interval excludes 0."""
    if len(xs) < 3 or len(set(xs)) < 2:
        return {
            "available": False,
            "error": "At least three values at different x are required.",
            "observations": len(xs),
        }
    factor = (
        hamed_rao_variance_factor(xs, list(remove_seasonal_cycle(xs, ys, season_length)))
        if len(set(xs)) == len(xs)
        else 1.0
    )
    result = theil_sen(xs, ys, variance_factor=factor)
    return {
        "available": True,
        "slope": _round_sig(result.slope),
        "intercept": _round(result.intercept),
        "confidence_interval": [_round_sig(result.low_slope), _round_sig(result.high_slope)],
        "significant": bool(result.low_slope > 0 or result.high_slope < 0),
        "trend_line": [_round(result.slope * x + result.intercept, 3) for x in xs],
        "exact": result.exact,
        "observations": result.observations,
    }


def _change_point(
    xs: list[float], ys: list[float], season_length: float | None = None
) -> dict[str, Any]:
    """Pettitt change point: where the level of the series shifts most clearly.

    With ``season_length`` (one year in x units) the seasonal cycle is removed
    first; otherwise a series starting in winter "shifts" every spring.
    """
    if len(ys) < 4:
        return {
            "available": False,
            "error": "At least four values are required to find a change point.",
            "observations": len(ys),
        }
    order = sorted(range(len(xs)), key=xs.__getitem__)
    sx = [xs[i] for i in order]
    sy = [ys[i] for i in order]
    tested = remove_seasonal_cycle(sx, sy, season_length)
    result = pettitt_test(sx, tested)
    before = sy[: result.index + 1]
    after = sy[result.index + 1 :]
    return {
        "available": True,
        "index": result.index,
        "x_before": sx[result.index],
        "x_after": sx[result.index + 1],
        "p_value": _round(result.p_value),
        "significant": bool(result.p_value < 0.05),
        "mean_before": _round(sum(before) / len(before), 3),
        "mean_after": _round(sum(after) / len(after), 3),
        "shift": _round(sum(after) / len(after) - sum(before) / len(before), 3),
        "deseasonalised": bool(any(abs(a - b) > 1e-12 for a, b in zip(tested, sy))),
        "k_statistic": _round(result.k_statistic, 1),
        "observations": result.observations,
    }


_RUNNERS = {
    "Linear Regression": _linear_regression,
    "t-Test": _t_test,
    "Mann-Kendall": _mann_kendall,
    "Sen's Slope": _sens_slope,
    "Change Point": _change_point,
}


def _run_all(
    xs: list[float], ys: list[float], names: Sequence[str], season_length: float | None
) -> dict[str, Any]:
    """Run the tools; with a seasonal cycle, on the values without it.

    For data finer than a year (``season_length`` = one year in x units)
    spanning at least two years, each value's time-of-year mean is
    subtracted first (12 phase bins, overall mean added back). The trend is
    unchanged, but the seasonal swing no longer counts as noise – monthly
    temperatures otherwise hide a clear warming – and ranges that are not
    whole years no longer bias the slope or the early/late comparison.
    Results computed this way carry ``deseasonalised: True``. The change
    point test handles the seasonal cycle itself and reports raw means.
    """
    tested = ys
    deseasonalised = False
    if season_length and len(ys) >= 4:
        adjusted = [float(v) for v in remove_seasonal_cycle(xs, ys, season_length)]
        if any(abs(a - b) > 1e-12 for a, b in zip(adjusted, ys)):
            tested, deseasonalised = adjusted, True
    results: dict[str, Any] = {}
    for name in names:
        if name == "Change Point":
            results[name] = _RUNNERS[name](xs, ys, season_length)
            continue
        result = _RUNNERS[name](xs, tested, season_length)
        if deseasonalised and result.get("available"):
            result["deseasonalised"] = True
        results[name] = result
    return results


def _add_rates(results: dict[str, Any], per_year: float, labels: Sequence[str] | None, xs: list[float]) -> None:
    """Add slopes per year/decade and, with ``labels``, the change-point date."""
    for name in ("Linear Regression", "Sen's Slope"):
        result = results.get(name)
        if result and result.get("available") and result.get("slope") is not None:
            result["slope_per_year"] = _round_sig(result["slope"] * per_year, 4)
            result["slope_per_decade"] = _round_sig(result["slope"] * per_year * 10, 4)
            low, high = result.get("confidence_interval") or [None, None]
            if low is not None and high is not None:
                result["confidence_interval_per_decade"] = [
                    _round_sig(low * per_year * 10, 3), _round_sig(high * per_year * 10, 3)
                ]
    change = results.get("Change Point")
    if labels is not None and change and change.get("available"):
        position = {x: i for i, x in enumerate(xs)}
        after = position.get(change["x_after"])
        if after is not None and after < len(labels):
            change["date"] = labels[after]


def run_tools(
    x: Sequence[Any],
    values: Sequence[Any],
    tools: Sequence[str],
    per_year: float | None = None,
    labels: Sequence[str] | None = None,
) -> dict[str, Any]:
    """Run the named tools on a series without the size limit for posted data.

    Used by :mod:`area_analysis` and :func:`src.task.process_user_request`
    for series built on the server.

    :param per_year: x units per year; adds ``slope_per_year`` and
        ``slope_per_decade`` to the slope tools.
    :param labels: One date label per value; adds the date of a change point.
    :raises AnalysisError: If a tool name is unknown or the input is malformed.
    """
    unknown = [name for name in tools if name not in _RUNNERS]
    if unknown:
        raise AnalysisError(f"Unknown tool(s): {', '.join(map(str, unknown))}.")
    if len(x) != len(values):
        raise AnalysisError("x and values must have the same length.")
    pairs = [
        (float(v), float(y))
        for v, y in zip(x, values)
        if y is not None and math.isfinite(float(v)) and math.isfinite(float(y))
    ]
    kept_labels = (
        [label for label, y in zip(labels, values) if y is not None and math.isfinite(float(y))]
        if labels is not None and len(labels) == len(values)
        else None
    )
    xs = [p[0] for p in pairs]
    ys = [p[1] for p in pairs]
    results = _run_all(xs, ys, tools, per_year)
    if per_year:
        _add_rates(results, per_year, kept_labels, xs)
    return results


def analyze_series(
    x: Sequence[Any],
    values: Sequence[Any],
    tools: Sequence[str] | None = None,
    season_length: float | None = None,
) -> dict[str, Any]:
    """Run the selected analysis tools on one series.

    :param x: Position of each value, for example the year (``2019, 2020, …``).
        The linear-regression slope is given per unit of ``x``.
    :param values: One value per ``x``; ``None`` marks a missing value.
    :param tools: Tool names from :func:`src.task.get_available_tools`.
        ``None`` or an empty list runs every tool.
    :param season_length: One year in units of ``x`` (e.g. 1 for decimal
        years); the change-point test then ignores the seasonal cycle.
    :return: ``{"observations": n, "tools": {name: result}}``. A result has
        ``available: False`` and an ``error`` if the series is too short.
    :raises AnalysisError: If the input is malformed or names an unknown tool.
    """
    xs, ys = _clean_series(x, values)
    known = get_available_tools()
    names = list(tools) if tools else known
    unknown = [name for name in names if name not in _RUNNERS]
    if unknown:
        raise AnalysisError(f"Unknown tool(s): {', '.join(map(str, unknown))}. Available: {', '.join(known)}")
    return {
        "observations": len(ys),
        "tools": _run_all(xs, ys, names, season_length),
    }


def analyze_groups(
    groups: Sequence[Any],
    tools: Sequence[str] | None = None,
) -> dict[str, Any]:
    """Run the selected tools separately on several series, e.g. one per year.

    The plot panel uses this to analyse a time frame such as January inside
    every year on its own: each group holds the values of one January and
    ``x`` is the day within that January, so a linear-regression slope is
    "per day within the period".

    :param groups: List of ``{"x": [...], "values": [...]}``; an optional
        ``"key"`` (e.g. the year) is passed back unchanged.
    :param tools: As for :func:`analyze_series`.
    :return: ``{"groups": [{"key": ..., "observations": n, "tools": {...}}]}``
        in the order given.
    :raises AnalysisError: If a group is malformed, there are too many groups
        or more than :data:`MAX_POINTS` values in total.
    """
    if not isinstance(groups, (list, tuple)):
        raise AnalysisError("groups must be a list.")
    if len(groups) > MAX_GROUPS:
        raise AnalysisError(f"At most {MAX_GROUPS} groups can be analysed at once.")
    total = 0
    results: list[dict[str, Any]] = []
    for group in groups:
        if not isinstance(group, dict):
            raise AnalysisError("Each group must be an object with x and values.")
        values = group.get("values", [])
        total += len(values) if isinstance(values, (list, tuple)) else 0
        if total > MAX_POINTS:
            raise AnalysisError(f"At most {MAX_POINTS} points can be analysed.")
        result = analyze_series(group.get("x", []), values, tools)
        results.append({"key": group.get("key"), **result})
    return {"groups": results}


__all__ = ["AnalysisError", "analyze_groups", "analyze_series", "run_tools"]
