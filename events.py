"""Find the notable events in a time series: the days that stand out.

A trend says how a quantity changes slowly; the events say *when* something
unusual happened, e.g. the record heat in Portland on 28 June 2021 or the
cloudburst in Berlin on 29 June 2017. They make a series tangible and are the
best starting point to explore it.

For every value the *normal* is the mean of the same time of year (a
±15-day window around the calendar day for daily data, the calendar month
for monthly data) over all years of the series; the *anomaly* is the
departure from it and ``z`` the anomaly in standard deviations of that time
of year. With less than :data:`MIN_CLIMATE_YEARS` years the whole series
serves as the normal.

Events found (see :func:`detect_events`):

* ``high`` / ``low``: the values most above / below normal, at most one per
  :data:`DECLUSTER_DAYS` days, so one heat wave yields one event;
* ``record_high`` / ``record_low``: the highest / lowest value of the series;
* ``warm_spell`` / ``cold_spell`` (daily data only): the longest run of days
  at least :data:`SPELL_Z` standard deviations above / below normal.

Amounts that are mostly zero or only extreme upwards (precipitation, snow,
wind) only get ``high`` events, ranked by their value instead of ``z``.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import date
from typing import Any, Iterable, Sequence

import numpy as np

MIN_CLIMATE_YEARS: int = 2
"""Years needed before the normal is taken per time of year."""

WINDOW_DAYS: int = 15
"""Half width of the calendar window of a daily normal."""

DECLUSTER_DAYS: int = 7
"""Two events of the same kind are at least this many days apart."""

SPELL_Z: float = 1.0
"""Standard deviations above / below normal that a day of a spell needs."""

MIN_SPELL_DAYS: int = 3

MAX_EVENTS: int = 8
"""Most events returned per series (records and spells included)."""

AMOUNT_CODES: frozenset[str] = frozenset(
    {"prcp", "mdpr", "snow", "snwd", "wesd", "wesf", "awnd", "wsfg", "wsf2", "wsf5",
     "emxp", "evap", "wind_speed", "wave_hgt"}
)
"""Codes whose unusual values are only the high ones (rain, snow, wind)."""


@dataclass(frozen=True)
class _Family:
    noun: str
    high: str
    low: str
    record_high: str
    record_low: str
    warm_spell: str = "Unusually high period"
    cold_spell: str = "Unusually low period"


_TEMPERATURE = _Family(
    "temperature", "Unusually warm", "Unusually cold", "Warmest value", "Coldest value",
    "Warm spell", "Cold spell",
)
_FAMILIES: dict[str, _Family] = {
    "prcp": _Family("precipitation", "Heavy precipitation", "", "Wettest day", ""),
    "mdpr": _Family("precipitation", "Heavy precipitation", "", "Wettest period", ""),
    "emxp": _Family("precipitation", "Heavy precipitation", "", "Wettest day", ""),
    "snow": _Family("snowfall", "Heavy snowfall", "", "Most snowfall", ""),
    "snwd": _Family("snow depth", "Deep snow", "", "Deepest snow", ""),
    "wesd": _Family("snow water", "Much snow water", "", "Most snow water", ""),
    "awnd": _Family("wind", "Strong wind", "", "Windiest day", ""),
    "wsfg": _Family("gusts", "Strong gusts", "", "Strongest gust", ""),
}


def _family(code: str, unit: str | None) -> _Family:
    code = code.lower()
    if code in _FAMILIES:
        return _FAMILIES[code]
    if (unit or "").replace(" ", "") in {"°C", "degC", "C"} or code in {
        "tmax", "tmin", "tavg", "emxt", "emnt", "air_temp", "sea_surf_temp", "dew_pt_temp",
    }:
        return _TEMPERATURE
    return _Family("value", "Unusually high", "Unusually low", "Highest value", "Lowest value")


def _fmt(value: float, unit: str | None) -> str:
    digits = 1 if abs(value) >= 10 else 2 if abs(value) >= 1 else 3
    text = f"{value:.{digits}f}".rstrip("0").rstrip(".")
    return f"{text} {unit}" if unit else text


def _climatology(days: np.ndarray, values: np.ndarray, daily: bool) -> tuple[np.ndarray, np.ndarray, bool]:
    """Normal and standard deviation for every value (same time of year).

    :return: ``(normal, std, seasonal)``; ``seasonal`` is False when the series
        was too short and the overall mean was used.
    """
    years = (days.max() - days.min()) / 365.2425 if days.size else 0
    overall_std = float(values.std()) or 1.0
    if years < MIN_CLIMATE_YEARS - 0.05:
        return np.full(values.size, values.mean()), np.full(values.size, overall_std), False
    if daily:
        # Day of the year without 29 February, so 31 December stays day 364
        # in leap years (it wrapped onto 1 January before).
        def day_of_year(ordinal: float) -> int:
            day = date.fromordinal(int(ordinal))
            index = day.timetuple().tm_yday - 1
            leap = day.year % 4 == 0 and (day.year % 100 != 0 or day.year % 400 == 0)
            return index - 1 if leap and index >= 59 else index

        doy = np.array([day_of_year(d) for d in days])
        sums = np.bincount(doy, weights=values, minlength=365)
        squares = np.bincount(doy, weights=values * values, minlength=365)
        counts = np.bincount(doy, minlength=365).astype(float)
        kernel = np.ones(2 * WINDOW_DAYS + 1)

        def circular(a: np.ndarray) -> np.ndarray:
            padded = np.concatenate([a[-WINDOW_DAYS:], a, a[:WINDOW_DAYS]])
            return np.convolve(padded, kernel, mode="valid")

        n = circular(counts)
        mean = np.divide(circular(sums), n, out=np.full(365, values.mean()), where=n > 0)
        var = np.divide(circular(squares), n, out=np.full(365, overall_std**2), where=n > 0) - mean**2
        std = np.sqrt(np.clip(var, 1e-12, None))
        std = np.where(std > 1e-6, std, overall_std)
        return mean[doy], std[doy], True
    months = np.array([date.fromordinal(int(d)).month - 1 for d in days])
    normal = np.empty(values.size)
    spread = np.empty(values.size)
    for m in range(12):
        mask = months == m
        if mask.any():
            normal[mask] = values[mask].mean()
            s = values[mask].std()
            spread[mask] = s if s > 1e-6 else overall_std
    return normal, spread, True


def _decluster(order: Iterable[int], days: np.ndarray, limit: int, gap: int) -> list[int]:
    chosen: list[int] = []
    for index in order:
        if len(chosen) >= limit:
            break
        if all(abs(days[index] - days[other]) >= gap for other in chosen):
            chosen.append(index)
    return chosen


def _iso(ordinal: float) -> str:
    return date.fromordinal(int(ordinal)).isoformat()


def detect_events(
    points: Sequence[tuple[date, float]],
    code: str = "",
    unit: str | None = None,
    daily: bool = True,
    max_events: int = MAX_EVENTS,
) -> list[dict[str, Any]]:
    """Notable events of one series; see the module docstring.

    :param points: ``(date, value)`` pairs; several values of one date are averaged.
    :param code: Variable code (``tmax``, ``prcp`` …) for wording and ranking.
    :param unit: Unit shown in the descriptions.
    :param daily: ``False`` for monthly or coarser values (no spells, monthly normal).
    :return: Events, most remarkable first, as JSON-friendly dicts with
        ``kind``, ``title``, ``date`` (ISO), ``value``, ``normal``,
        ``anomaly``, ``z``, ``percentile``, ``description`` and for spells
        ``end`` and ``days``.
    """
    by_day: dict[int, list[float]] = {}
    for day, value in points:
        try:
            v = float(value)
        except (TypeError, ValueError):
            continue
        if math.isfinite(v):
            by_day.setdefault(day.toordinal(), []).append(v)
    if len(by_day) < 10:
        return []
    days = np.array(sorted(by_day), dtype=float)
    values = np.array([sum(by_day[int(d)]) / len(by_day[int(d)]) for d in days])
    if float(values.max() - values.min()) == 0:
        return []
    normal, spread, seasonal = _climatology(days, values, daily)
    anomaly = values - normal
    z = anomaly / spread
    ranks = values.argsort().argsort()
    percentile = 100.0 * (ranks + 0.5) / values.size
    family = _family(code, unit)
    amount = code.lower() in AMOUNT_CODES
    gap = DECLUSTER_DAYS if daily else 45
    normal_word = "the normal for the time of year" if seasonal else "the mean of the series"
    events: list[dict[str, Any]] = []

    def event(index: int, kind: str, title: str, extra: str = "") -> dict[str, Any]:
        value = float(values[index])
        delta = float(anomaly[index])
        sign = "above" if delta >= 0 else "below"
        pct = float(percentile[index])
        share = (100 - pct) if value >= float(np.median(values)) else pct
        word = "highest" if value >= float(np.median(values)) else "lowest"
        rarity = (
            f"the {word} of all {values.size} values"
            if (word == "highest" and index == int(values.argmax())) or (word == "lowest" and index == int(values.argmin()))
            else f"among the {word} {max(share, 0.1):.1f} % of all values"
        )
        text = f"{_fmt(value, unit)}, {_fmt(abs(delta), unit)} {sign} {normal_word} ({_fmt(float(normal[index]), unit)}); {rarity}."
        return {
            "kind": kind,
            "title": title,
            "date": _iso(days[index]),
            "value": round(value, 3),
            "normal": round(float(normal[index]), 3),
            "anomaly": round(delta, 3),
            "z": round(float(z[index]), 2),
            "percentile": round(pct, 2),
            "unit": unit,
            "description": extra + text,
        }

    # Records of the selected time range.
    top = int(values.argmax())
    events.append(event(top, "record_high", family.record_high, "Highest value of the selected time range: "))
    if not amount:
        bottom = int(values.argmin())
        events.append(event(bottom, "record_low", family.record_low, "Lowest value of the selected time range: "))

    # Spells (daily, non-amount).
    if daily and not amount and seasonal:
        for kind, title, sign in (("warm_spell", family.warm_spell, 1), ("cold_spell", family.cold_spell, -1)):
            runs: list[tuple[int, int]] = []
            start: int | None = None
            for i in range(values.size):
                ok = bool(sign * z[i] >= SPELL_Z)
                if ok and start is not None and days[i] - days[i - 1] == 1:
                    continue
                if start is not None:
                    runs.append((start, i))
                    start = None
                if ok:
                    start = i
            if start is not None:
                runs.append((start, values.size))
            # Strongest spell: duration and intensity together (sum of z).
            runs = [r for r in runs if r[1] - r[0] >= MIN_SPELL_DAYS]
            best = max(runs, key=lambda r: sign * float(z[r[0] : r[1]].sum()), default=None)
            if best and best[1] - best[0] >= MIN_SPELL_DAYS:
                segment = range(best[0], best[1])
                peak = max(segment, key=lambda k: sign * z[k])
                length = best[1] - best[0]
                mean_anomaly = float(anomaly[best[0] : best[1]].mean())
                e = event(
                    peak,
                    kind,
                    title,
                    f"{length} days in a row {'above' if sign > 0 else 'below'} normal, "
                    f"on average {_fmt(abs(mean_anomaly), unit)}; peak: ",
                )
                e["date"] = _iso(days[best[0]])
                e["end"] = _iso(days[best[1] - 1])
                e["peak_date"] = _iso(days[peak])
                e["days"] = length
                events.append(e)

    # Most unusual single values, declustered.
    taken = {e["date"] for e in events} | {e.get("peak_date") for e in events}
    score = values if amount else z
    highs = _decluster(np.argsort(-score), days, max_events, gap)
    lows = [] if amount else _decluster(np.argsort(score), days, max_events, gap)
    candidates: list[tuple[float, int, str]] = []
    for i in highs:
        if (amount and values[i] > 0) or (not amount and z[i] >= 1.5):
            candidates.append((abs(float(z[i])) if not amount else float(percentile[i]), i, "high"))
    for i in lows:
        if z[i] <= -1.5:
            candidates.append((abs(float(z[i])), i, "low"))
    candidates.sort(reverse=True)
    for _, i, kind in candidates:
        if len(events) >= max_events:
            break
        iso = _iso(days[i])
        if iso in taken or any(
            abs(days[i] - date.fromisoformat(e["date"]).toordinal()) < gap
            and e["kind"].startswith(kind if kind == "high" else "low")
            for e in events
        ):
            continue
        taken.add(iso)
        events.append(event(i, kind, family.high if kind == "high" else family.low))
    return events[:max_events]


def events_for_records(
    records: Sequence[dict[str, Any]], code: str, unit: str | None
) -> list[dict[str, Any]]:
    """:func:`detect_events` on raw observation records of one variable."""
    from src.task import _parse_observation_period

    points: list[tuple[date, float]] = []
    lengths: list[int] = []
    for record in records:
        try:
            first, last = _parse_observation_period(str(record["date"]))
            value = float(record["value"])
        except (KeyError, TypeError, ValueError):
            continue
        points.append((first, value))
        lengths.append((last - first).days + 1)
    if not points:
        return []
    daily = sorted(lengths)[len(lengths) // 2] <= 1
    return detect_events(points, code, unit, daily=daily)


def events_for_series(
    labels: Sequence[str], values: Sequence[float], code: str, unit: str | None, step_days: float
) -> list[dict[str, Any]]:
    """:func:`detect_events` on a binned series (labels ``DD.MM.YYYY``)."""
    points: list[tuple[date, float]] = []
    for label, value in zip(labels, values):
        try:
            d, m, y = (int(part) for part in str(label).split("."))
            points.append((date(y, m, d), float(value)))
        except (TypeError, ValueError):
            continue
    if step_days > 400:
        return []
    return detect_events(points, code, unit, daily=step_days <= 1.5)


__all__ = ["detect_events", "events_for_records", "events_for_series"]
