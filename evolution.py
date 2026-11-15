"""How one value per year develops: the "Change over time" section of the plot panel.

The plot panel can reduce a topic to one value per year, for example the
annual mean or the mean of every January. :func:`evolution` turns such a
series into numbers a scientist can quote ("every 10-year window since 1975
warmed, by +0.3 to +0.6 °C/decade") instead of reading them off a plot:

* ``series``: each year's value with its 95 % interval, anomaly and change
  from the year before,
* ``baseline``: the reference period of the anomalies,
* ``trend``: linear (OLS) and Sen's slope plus the Mann-Kendall test over all
  years,
* ``running``: the OLS trend in every sliding window of ``window_years``,
* ``decades``: the mean of every calendar decade (1980–1989 = "1980s"),
* ``consistency``: plain counts (years above the baseline, positive windows …),
* ``notes``: caveats in short sentences.

The statistics are the ones of :mod:`plot_analysis` (and so of
:mod:`src.task`): p-values and intervals of the slopes are corrected for
lag-1 autocorrelation (Santer et al. 2000; Hamed & Rao 1998 for
Mann-Kendall). Slopes are per year unless the key says ``per_decade``. The
output is JSON-friendly: missing numbers are ``None``, never NaN.
"""

from __future__ import annotations

import bisect
import math
from typing import Any, Sequence

from scipy import stats

from plot_analysis import AnalysisError, _linear_regression, _mann_kendall, _round, _round_sig, _sens_slope

MAX_YEARS: int = 2000
"""Most years accepted in one call."""

MAX_SPAN: int = 5000
"""Largest distance between the first and the last year (bounds the window loops)."""

MAX_WINDOW: int = 100
"""Longest running-trend window in years."""

MIN_WINDOW_VALUES: int = 5
"""Fewest values a running window or a decade needs."""

MIN_WINDOW_COVERAGE: float = 0.7
"""Share of a window's calendar years that must have a value."""

WMO_NORMALS: tuple[tuple[int, int], ...] = ((1961, 1990), (1991, 2020))
"""WMO reference periods, in order of preference.

1961–1990 comes first: WMO keeps it as the stable reference for assessing
long-term climate change (and DWD uses it for exactly that), which is what
this section is about. 1991–2020 is the current standard normal.
"""

WMO_MIN_YEARS: int = 24
"""Years with a value a WMO normal needs to be used (80 % of 30, WMO guidance)."""


# --------------------------------------------------------------------------- input


def _as_int_year(raw: Any) -> int:
    """A year as ``int``; integral floats such as ``1990.0`` are accepted.

    :raises AnalysisError: For booleans, non-numbers and fractional years.
    """
    if isinstance(raw, bool) or not isinstance(raw, (int, float)):
        raise AnalysisError("years must be integers.")
    if isinstance(raw, float) and (not math.isfinite(raw) or not raw.is_integer()):
        raise AnalysisError("years must be integers.")
    return int(raw)


def _as_float(raw: Any, name: str) -> float | None:
    """A finite float, or ``None`` for ``None``, NaN and infinity.

    :raises AnalysisError: For booleans and non-numbers.
    """
    if raw is None:
        return None
    if isinstance(raw, bool):
        raise AnalysisError(f"{name} must be numbers.")
    try:
        value = float(raw)
    except (TypeError, ValueError) as exc:
        raise AnalysisError(f"{name} must be numbers.") from exc
    return value if math.isfinite(value) else None


def _optional_list(raw: Any, name: str, length: int) -> list[Any]:
    """``raw`` as a list of ``length`` entries; ``None`` gives a list of ``None``.

    :raises AnalysisError: If ``raw`` is not a list of that length.
    """
    if raw is None:
        return [None] * length
    if not isinstance(raw, (list, tuple)) or len(raw) != length:
        raise AnalysisError(f"{name} must be a list as long as years.")
    return list(raw)


def _clean(
    years: Any, values: Any, n: Any, sd: Any
) -> list[tuple[int, float, float | None, float | None]]:
    """Validated ``(year, value, n, sd)`` rows sorted by year, without missing values.

    :raises AnalysisError: If the lists are malformed, too long, a year repeats
        or ``n``/``sd`` is negative.
    """
    if not isinstance(years, (list, tuple)) or not isinstance(values, (list, tuple)):
        raise AnalysisError("years and values must be lists.")
    if len(years) != len(values):
        raise AnalysisError("years and values must have the same length.")
    if len(years) > MAX_YEARS:
        raise AnalysisError(f"At most {MAX_YEARS} years can be analysed.")
    counts = _optional_list(n, "n", len(years))
    spreads = _optional_list(sd, "sd", len(years))
    rows: dict[int, tuple[int, float, float | None, float | None]] = {}
    for raw_year, raw_value, raw_n, raw_sd in zip(years, values, counts, spreads):
        year = _as_int_year(raw_year)
        if year in rows:
            raise AnalysisError(f"Year {year} appears more than once.")
        value = _as_float(raw_value, "values")
        count = _as_float(raw_n, "n")
        spread = _as_float(raw_sd, "sd")
        if (count is not None and count < 0) or (spread is not None and spread < 0):
            raise AnalysisError("n and sd must not be negative.")
        if value is not None:
            rows[year] = (year, value, count, spread)
    ordered = [rows[year] for year in sorted(rows)]
    if not ordered:
        raise AnalysisError("No year has a finite value.")
    if ordered[-1][0] - ordered[0][0] >= MAX_SPAN:
        raise AnalysisError(f"The years must lie within {MAX_SPAN} years of each other.")
    return ordered


def _window_years(raw: Any) -> int:
    """Validated running-window length.

    :raises AnalysisError: Unless an integer from :data:`MIN_WINDOW_VALUES` to :data:`MAX_WINDOW`.
    """
    window = _as_int_year(raw) if raw is not None else 10
    if not MIN_WINDOW_VALUES <= window <= MAX_WINDOW:
        raise AnalysisError(f"window_years must be between {MIN_WINDOW_VALUES} and {MAX_WINDOW}.")
    return window


# --------------------------------------------------------------------------- pieces


def _mean_interval(values: Sequence[float]) -> tuple[float, float | None, float | None]:
    """Mean and its 95 % t interval (``None`` for fewer than two values)."""
    k = len(values)
    mean = sum(values) / k
    if k < 2:
        return mean, None, None
    sd = math.sqrt(sum((v - mean) ** 2 for v in values) / (k - 1))
    margin = float(stats.t.ppf(0.975, k - 1)) * sd / math.sqrt(k)
    return mean, mean - margin, mean + margin


def _year_interval(value: float, count: float | None, spread: float | None) -> tuple[float | None, float | None]:
    """``value ± t(0.975, n-1)·sd/√n``, or ``(None, None)`` without n ≥ 2 and sd."""
    if count is None or spread is None or count < 2:
        return None, None
    margin = float(stats.t.ppf(0.975, count - 1)) * spread / math.sqrt(count)
    return value - margin, value + margin


def _choose_baseline(years: list[int], requested: Any) -> tuple[int, int, str]:
    """Reference period ``(start, end, kind)`` of the anomalies.

    * ``requested`` ``[start, end]``: that period (``kind="custom"``).
    * Otherwise a WMO normal from :data:`WMO_NORMALS` that the series spans
      with at least :data:`WMO_MIN_YEARS` values (``kind="wmo_normal"``).
    * Otherwise the first ``min(30, max(5, len // 3))`` years with a value
      (``kind="first_years"``).

    :raises AnalysisError: If ``requested`` is not a pair of years with start ≤ end.
    """
    if requested is not None:
        if not isinstance(requested, (list, tuple)) or len(requested) != 2:
            raise AnalysisError("baseline must be [start_year, end_year].")
        start, end = _as_int_year(requested[0]), _as_int_year(requested[1])
        if start > end:
            raise AnalysisError("baseline start must not be after its end.")
        return start, end, "custom"
    for start, end in WMO_NORMALS:
        inside = sum(1 for y in years if start <= y <= end)
        if years[0] <= start and years[-1] >= end and inside >= WMO_MIN_YEARS:
            return start, end, "wmo_normal"
    count = min(30, max(5, len(years) // 3), len(years))
    return years[0], years[count - 1], "first_years"


def _series(
    rows: list[tuple[int, float, float | None, float | None]], baseline_mean: float
) -> list[dict[str, Any]]:
    """Per-year entries with interval, anomaly and change from the year before."""
    by_year = {year: value for year, value, _, _ in rows}
    out = []
    for year, value, count, spread in rows:
        low, high = _year_interval(value, count, spread)
        previous = by_year.get(year - 1)
        out.append({
            "year": year,
            "value": _round(value),
            "ci_low": _round(low) if low is not None else None,
            "ci_high": _round(high) if high is not None else None,
            "anomaly": _round(value - baseline_mean),
            "change_from_previous": _round(value - previous) if previous is not None else None,
        })
    return out


def _trend(years: list[int], values: list[float]) -> dict[str, Any]:
    """OLS, Sen's slope and Mann-Kendall over all years (slopes per year and decade)."""
    xs = [float(y) for y in years]
    ols = _linear_regression(xs, values)
    if not ols.get("available"):
        return {"available": False, "error": ols.get("error"), "n_years": len(values)}
    sen = _sens_slope(xs, values)
    mk = _mann_kendall(xs, values)
    slope = ols["slope"]
    low, high = ols["confidence_interval"]
    sen_low, sen_high = sen["confidence_interval"]
    s_stat = mk["s_statistic"]
    return {
        "available": True,
        "n_years": len(values),
        "first_year": years[0],
        "last_year": years[-1],
        "slope": slope,
        "slope_per_decade": _round_sig(slope * 10),
        "ci_low": low,
        "ci_high": high,
        "ci_low_per_decade": _round_sig(low * 10) if low is not None else None,
        "ci_high_per_decade": _round_sig(high * 10) if high is not None else None,
        "p_value": ols["p_value"],
        "p_value_unadjusted": ols["p_value_unadjusted"],
        "autocorrelation": ols["autocorrelation"],
        "effective_n": ols["effective_n"],
        "r_squared": ols["r_squared"],
        "significant": ols["significant"],
        "total_change": _round(slope * (years[-1] - years[0])),
        "sen_slope": sen["slope"],
        "sen_slope_per_decade": _round_sig(sen["slope"] * 10),
        "sen_ci_low": sen_low,
        "sen_ci_high": sen_high,
        "sen_significant": sen["significant"],
        "mk_p_value": mk["p_value"],
        "mk_tau": mk["tau"],
        "mk_direction": "increasing" if s_stat > 0 else "decreasing" if s_stat < 0 else "none",
        "mk_significant": mk["significant"],
    }


def _running(years: list[int], values: list[float], window: int) -> tuple[list[dict[str, Any]], int]:
    """OLS trend in every window of ``window`` consecutive calendar years.

    A window is skipped if fewer than :data:`MIN_WINDOW_COVERAGE` of its years
    or fewer than :data:`MIN_WINDOW_VALUES` years have a value.

    :return: The window results and the number of skipped windows.
    """
    needed = max(MIN_WINDOW_VALUES, math.ceil(MIN_WINDOW_COVERAGE * window - 1e-9))
    points: list[dict[str, Any]] = []
    skipped = 0
    for start in range(years[0], years[-1] - window + 2):
        end = start + window - 1
        lo, hi = bisect.bisect_left(years, start), bisect.bisect_right(years, end)
        if hi - lo < needed:
            skipped += 1
            continue
        fit = _linear_regression([float(y) for y in years[lo:hi]], values[lo:hi])
        if not fit.get("available"):
            skipped += 1
            continue
        low, high = fit["confidence_interval"]
        points.append({
            "start": start,
            "end": end,
            "centre": (start + end) / 2,
            "n": hi - lo,
            "slope": fit["slope"],
            "ci_low": low,
            "ci_high": high,
            "p": fit["p_value"],
            "significant": fit["significant"],
        })
    return points, skipped


def _decades(years: list[int], values: list[float]) -> tuple[list[dict[str, Any]], int]:
    """Mean of every calendar decade (1980–1989 = ``"1980s"``) with ≥ 5 years.

    The interval is the 95 % t interval of the mean of the decade's yearly
    values. ``diff_to_first`` compares with the first decade kept.

    :return: The decades and the number dropped for having too few years.
    """
    groups: dict[int, list[float]] = {}
    for year, value in zip(years, values):
        groups.setdefault(year // 10 * 10, []).append(value)
    blocks: list[dict[str, Any]] = []
    dropped = 0
    first_mean: float | None = None
    for start in sorted(groups):
        block = groups[start]
        if len(block) < MIN_WINDOW_VALUES:
            dropped += 1
            continue
        mean, low, high = _mean_interval(block)
        first_mean = mean if first_mean is None else first_mean
        blocks.append({
            "label": f"{start}s",
            "start": start,
            "end": start + 9,
            "n": len(block),
            "mean": _round(mean),
            "ci_low": _round(low) if low is not None else None,
            "ci_high": _round(high) if high is not None else None,
            "diff_to_first": _round(mean - first_mean),
        })
    return blocks, dropped


def _consistency(series: list[dict[str, Any]], running: list[dict[str, Any]]) -> dict[str, int]:
    """Counts a scientist would quote, e.g. "38 of 50 years above the baseline"."""
    changes = [p["change_from_previous"] for p in series if p["change_from_previous"] is not None]
    slopes = [(p["slope"], p["significant"]) for p in running if p["slope"] is not None]
    return {
        "years_above_baseline": sum(1 for p in series if p["anomaly"] is not None and p["anomaly"] > 0),
        "years_compared": sum(1 for p in series if p["anomaly"] is not None),
        "running_positive": sum(1 for s, _ in slopes if s > 0),
        "running_negative": sum(1 for s, _ in slopes if s < 0),
        "running_significant_positive": sum(1 for s, sig in slopes if sig and s > 0),
        "running_significant_negative": sum(1 for s, sig in slopes if sig and s < 0),
        "running_total": len(running),
        "increases_vs_previous": sum(1 for c in changes if c > 0),
        "decreases_vs_previous": sum(1 for c in changes if c < 0),
    }


# --------------------------------------------------------------------------- entry point


def evolution(
    years: Sequence[Any],
    values: Sequence[Any],
    *,
    n: Sequence[Any] | None = None,
    sd: Sequence[Any] | None = None,
    window_years: Any = 10,
    baseline: Any = None,
) -> dict[str, Any]:
    """Describe how a value-per-year series changes over time.

    :param years: Integer years, in any order and possibly with gaps.
    :param values: One value per year; ``None``, NaN and infinity are skipped.
    :param n: Optional number of values that went into each year's value.
    :param sd: Optional standard deviation of those values (``None`` per entry allowed).
        With ``n ≥ 2`` and ``sd`` a year gets ``value ± t(0.975, n-1)·sd/√n``.
    :param window_years: Length of the running-trend windows (5–100, default 10).
    :param baseline: ``[start_year, end_year]`` of the anomaly reference; see
        :func:`_choose_baseline` for the default.
    :return: ``{"series", "baseline", "trend", "running", "decades",
        "consistency", "notes"}`` as described in the module docstring.
    :raises AnalysisError: If the input is malformed, too long, or the
        baseline holds no year with a value.
    """
    rows = _clean(years, values, n, sd)
    window = _window_years(window_years)
    ys = [row[0] for row in rows]
    vs = [row[1] for row in rows]
    notes: list[str] = []

    start, end, kind = _choose_baseline(ys, baseline)
    base_values = [v for y, v in zip(ys, vs) if start <= y <= end]
    if not base_values:
        raise AnalysisError(f"The baseline {start}–{end} contains no year with a value.")
    base_mean = sum(base_values) / len(base_values)
    if len(base_values) < 10:
        notes.append(f"Baseline {start}–{end} rests on only {len(base_values)} years; anomalies are uncertain.")

    series = _series(rows, base_mean)
    span = ys[-1] - ys[0] + 1
    if span > len(ys):
        notes.append(f"{span - len(ys)} of {span} years between {ys[0]} and {ys[-1]} have no value.")
    if all(p["ci_low"] is None for p in series):
        notes.append("No per-year n and sd given (or n < 2): yearly confidence intervals omitted.")

    trend = _trend(ys, vs)
    if not trend["available"]:
        notes.append("Fewer than 3 years with values: no trend computed.")
    elif len(vs) < 10:
        notes.append(f"Only {len(vs)} years: the overall trend is very uncertain.")

    if span < window:
        points, skipped = [], 0
        notes.append(f"The series spans fewer than {window} years: running {window}-year trends not computed.")
    else:
        points, skipped = _running(ys, vs, window)
        if skipped:
            notes.append(f"{skipped} running windows skipped (fewer than 70 % of years or 5 values).")
        if points:
            notes.append(
                "Running windows overlap, so their counts are not independent tests; "
                "p-values are corrected for lag-1 autocorrelation, which is rough with few values."
            )

    blocks, dropped = _decades(ys, vs)
    if dropped:
        notes.append(f"{dropped} decade(s) with fewer than 5 years left out.")

    return {
        "series": series,
        "baseline": {
            "start": start,
            "end": end,
            "kind": kind,
            "mean": _round(base_mean),
            "years_used": len(base_values),
        },
        "trend": trend,
        "running": {"window_years": window, "points": points},
        "decades": blocks,
        "consistency": _consistency(series, points),
        "notes": notes,
    }


__all__ = ["evolution", "MAX_YEARS"]
