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

from src.task import (
    LinearRegression,
    TTest,
    get_available_tools,
    mann_kendall_test,
)

MAX_POINTS: int = 10_000
"""Largest series accepted from the frontend."""

MAX_GROUPS: int = 500
"""Most groups (e.g. one per year) accepted in one call to :func:`analyze_groups`."""


class AnalysisError(ValueError):
    """Raised when the posted series cannot be analysed."""


def _round(value: float, digits: int = 4) -> float | None:
    """Round a finite number for JSON; encode NaN and infinity as ``None``."""
    value = float(value)
    return round(value, digits) if math.isfinite(value) else None


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


def _linear_regression(xs: list[float], ys: list[float]) -> dict[str, Any]:
    """Slope per x unit, intercept, fit quality and slope test."""
    if len(xs) < 3 or len(set(xs)) < 2:
        return {
            "available": False,
            "error": "At least three values at different x are required.",
            "observations": len(xs),
        }
    trend = LinearRegression().analyze_trend(xs, ys)
    return {
        "available": True,
        "slope": _round(trend.slope),
        "intercept": _round(trend.intercept),
        "r_squared": _round(trend.r_value**2),
        "p_value": _round(trend.p_value),
        "confidence_interval": [
            _round(trend.confidence_interval[0]),
            _round(trend.confidence_interval[1]),
        ],
        "significant": bool(trend.p_value < 0.05),
        "trend_line": [_round(trend.slope * x + trend.intercept, 3) for x in xs],
        "observations": trend.observations,
    }


def _t_test(xs: list[float], ys: list[float]) -> dict[str, Any]:
    """Welch t-test of the first half against the second half of the series."""
    if len(ys) < 4:
        return {
            "available": False,
            "error": "At least four values are required to compare two halves.",
            "observations": len(ys),
        }
    statistic, p_value = TTest().process(torch.tensor(xs), torch.tensor(ys))
    middle = len(ys) // 2
    return {
        "available": True,
        "t_statistic": _round(float(statistic.item())),
        "p_value": _round(float(p_value.item())),
        "significant": bool(float(p_value.item()) < 0.05),
        "early_mean": _round(sum(ys[:middle]) / middle, 3),
        "late_mean": _round(sum(ys[middle:]) / (len(ys) - middle), 3),
        "split_x": xs[middle],
        "observations": len(ys),
    }


def _mann_kendall(xs: list[float], ys: list[float]) -> dict[str, Any]:
    """Mann-Kendall test for a monotonic trend."""
    if len(ys) < 3:
        return {
            "available": False,
            "error": "At least three values are required for the Mann-Kendall test.",
            "observations": len(ys),
        }
    result = mann_kendall_test(xs, ys)
    return {
        "available": True,
        "trend": result.trend,
        "p_value": _round(result.p_value),
        "tau": _round(result.tau),
        "z_statistic": _round(result.z_statistic),
        "s_statistic": result.s_statistic,
        "significant": bool(result.p_value < result.alpha),
        "observations": result.observations,
    }


_RUNNERS = {
    "Linear Regression": _linear_regression,
    "t-Test": _t_test,
    "Mann-Kendall": _mann_kendall,
}


def run_tools(
    x: Sequence[Any],
    values: Sequence[Any],
    tools: Sequence[str],
) -> dict[str, Any]:
    """Run the named tools on a series without the size limit for posted data.

    Used by :mod:`area_analysis` for series built on the server.

    :raises AnalysisError: If a tool name is unknown or the input is malformed.
    """
    unknown = [name for name in tools if name not in _RUNNERS]
    if unknown:
        raise AnalysisError(f"Unknown tool(s): {', '.join(map(str, unknown))}.")
    if len(x) != len(values):
        raise AnalysisError("x and values must have the same length.")
    xs = [float(v) for v, y in zip(x, values) if y is not None]
    ys = [float(y) for y in values if y is not None]
    return {name: _RUNNERS[name](xs, ys) for name in tools}


def analyze_series(
    x: Sequence[Any],
    values: Sequence[Any],
    tools: Sequence[str] | None = None,
) -> dict[str, Any]:
    """Run the selected analysis tools on one series.

    :param x: Position of each value, for example the year (``2019, 2020, …``).
        The linear-regression slope is given per unit of ``x``.
    :param values: One value per ``x``; ``None`` marks a missing value.
    :param tools: Tool names from :func:`src.task.get_available_tools`.
        ``None`` or an empty list runs every tool.
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
        "tools": {name: _RUNNERS[name](xs, ys) for name in names},
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
