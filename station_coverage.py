"""When do the stations around a point or in a region have data?

A request returns no values when the stations nearby stopped reporting
before the selected time frame (or started after it). The NOAA Search
Service knows the period of record of every station and code, so this
module looks it up and answers which years have data and which time frame
would work instead. It only reads station metadata; no observations are
downloaded.

Used by ``POST /api/coverage`` in :mod:`app`.
"""

from __future__ import annotations

import math
import re
from datetime import date, datetime
from functools import lru_cache
from typing import Any

import area_analysis
import noaa_api

POINT_RADII_DEGREES: tuple[float, ...] = (0.5, 1.0, 2.0)
"""Half-widths of the search box around a point, tried until a station is found."""
PAGE_SIZE = 1000
MAX_PAGES = 3
MAX_CODES = 4
"""Topics like soil temperature have dozens of codes; only the best covered are shown."""
MAX_LISTED_STATIONS = 5
SUGGESTED_SPANS_YEARS: tuple[int, ...] = (30, 20, 10, 5, 2, 1)
"""Window lengths tried for the suggested time frame, longest first."""

_CODE_IN_KEY = re.compile(r"\(([A-Z0-9_]+)\)\s*$")


class CoverageError(ValueError):
    """The request cannot be answered (unknown topic, no area, moving platforms)."""


def _parse_day(text: Any) -> date | None:
    try:
        return datetime.fromisoformat(str(text)[:10]).date()
    except ValueError:
        return None


def _parse_dd_mm_yyyy(text: Any) -> date | None:
    try:
        return datetime.strptime(str(text).strip(), "%d.%m.%Y").date()
    except ValueError:
        return None


def _topic_and_codes(result_key: str) -> tuple[str, noaa_api.NOAATopic, tuple[str, ...]]:
    """Topic of a result card key such as ``temperature · maximum (TMAX)``."""
    topic_key = result_key.split(" · ")[0].strip().lower()
    topic = noaa_api.TOPICS.get(topic_key)
    if topic is None:
        raise CoverageError(f"Unknown topic {result_key!r}.")
    if topic.dataset in noaa_api.MOVING_PLATFORM_DATASETS:
        raise CoverageError("Ships and buoys move, so there is no fixed period of record to show.")
    match = _CODE_IN_KEY.search(result_key)
    if match and match.group(1) in topic.data_types:
        return topic_key, topic, (match.group(1),)
    return topic_key, topic, topic.data_types


@lru_cache(maxsize=64)
def _search(dataset: str, bbox: str) -> tuple[dict[str, Any], ...]:
    """All search results (station files) of a dataset in a ``N,W,S,E`` box.

    No ``dataTypes`` filter: every station lists the period of record of each
    of its codes, so one search serves all codes. Cached because the cards of
    one request usually ask for the same box.
    """
    client = noaa_api.NOAAClient(timeout=30.0, max_request_seconds=60.0)
    results: list[dict[str, Any]] = []
    for page in range(MAX_PAGES):
        payload = client._get_json(
            noaa_api.SEARCH_URL,
            {"dataset": dataset, "bbox": bbox, "limit": str(PAGE_SIZE), "offset": str(page * PAGE_SIZE)},
        )
        batch = payload.get("results", []) if isinstance(payload, dict) else []
        results.extend(r for r in batch if isinstance(r, dict))
        total = payload.get("count", 0) if isinstance(payload, dict) else 0
        if len(batch) < PAGE_SIZE or len(results) >= total:
            break
    return tuple(results)


def _collect(
    results: tuple[dict[str, Any], ...],
    codes: tuple[str, ...],
    centre: tuple[float, float] | None,
) -> dict[str, dict[str, dict[str, Any]]]:
    """``{code: {station id: station}}`` with first/last day and active years.

    Hourly datasets have one search result per station and year, so the
    years are collected per result rather than spanned from first to last.
    """
    by_code: dict[str, dict[str, dict[str, Any]]] = {code: {} for code in codes}
    for result in results:
        location = (result.get("location") or {}).get("coordinates") or result.get("centroid") or []
        if len(location) < 2:
            continue
        lon, lat = float(location[0]), float(location[1])
        for station in result.get("stations", []):
            station_id = station.get("id")
            if not station_id:
                continue
            for data_type in station.get("dataTypes", []):
                code = data_type.get("id") if isinstance(data_type, dict) else None
                if code not in by_code:
                    continue
                first = _parse_day(data_type.get("startDate"))
                last = _parse_day(data_type.get("endDate"))
                if first is None or last is None or last < first:
                    continue
                entry = by_code[code].setdefault(
                    station_id,
                    {
                        "id": station_id,
                        "name": station.get("name") or station_id,
                        "latitude": round(lat, 4),
                        "longitude": round(lon, 4),
                        "distance_km": (
                            round(noaa_api.NOAAClient._distance_km(centre[0], centre[1], lat, lon), 1)
                            if centre
                            else None
                        ),
                        "first": first,
                        "last": last,
                        "years": set(),
                    },
                )
                entry["first"] = min(entry["first"], first)
                entry["last"] = max(entry["last"], last)
                entry["years"].update(range(first.year, last.year + 1))
    return by_code


def _covers(station: dict[str, Any], first_year: int, last_year: int) -> bool:
    """Station reports in at least 80 % of the years (as a region evaluation needs)."""
    span = last_year - first_year + 1
    active = sum(1 for year in range(first_year, last_year + 1) if year in station["years"])
    return active >= area_analysis.MIN_COVERAGE * span


def _suggest(stations: list[dict[str, Any]], needed: int, last_year: int) -> tuple[date, date] | None:
    """The most recent, longest time frame in which ``needed`` stations report."""
    if len(stations) < needed:
        return None
    first_year = min(s["first"].year for s in stations)
    for span in SUGGESTED_SPANS_YEARS:
        for end_year in range(last_year, first_year + span - 2, -1):
            start_year = end_year - span + 1
            covering = [s for s in stations if _covers(s, start_year, end_year)]
            if len(covering) >= needed:
                # In a running year the data stops at the last reported day.
                end_day = min(date(end_year, 12, 31), max(s["last"] for s in covering))
                return date(start_year, 1, 1), end_day
    return None


def _code_summary(
    code: str,
    stations: dict[str, dict[str, Any]],
    needed: int,
    requested: tuple[date, date] | None,
    is_point: bool,
) -> dict[str, Any]:
    listed = list(stations.values())
    first_year = min(s["first"].year for s in listed)
    last_year = max(s["last"].year for s in listed)
    years = list(range(first_year, last_year + 1))
    counts = [sum(1 for s in listed if year in s["years"]) for year in years]
    suggestion = _suggest(listed, needed, last_year)

    in_range = None
    if requested:
        start, end = requested
        in_range = sum(1 for s in listed if _covers(s, start.year, end.year))

    if is_point:
        ranked = sorted(listed, key=lambda s: (s["distance_km"], s["id"]))
    else:
        ranked = sorted(listed, key=lambda s: (-len(s["years"]), s["id"]))
    return {
        "code": code,
        "name": noaa_api_name(code),
        "station_count": len(listed),
        "first": min(s["first"] for s in listed).isoformat(),
        "last": max(s["last"] for s in listed).isoformat(),
        "years": years,
        "counts": counts,
        "in_range": in_range,
        "suggestion": [suggestion[0].isoformat(), suggestion[1].isoformat()] if suggestion else None,
        "stations": [
            {
                "id": s["id"],
                "name": s["name"],
                "first": s["first"].isoformat(),
                "last": s["last"].isoformat(),
                "distance_km": s["distance_km"],
            }
            for s in ranked[:MAX_LISTED_STATIONS]
        ],
    }


def noaa_api_name(code: str) -> str | None:
    """Readable name of a NOAA code (``TMAX`` → ``maximum``), if known."""
    try:
        from src import task
    except ImportError:  # pragma: no cover - only when run outside the project root
        return None
    return task.VARIABLE_NAMES.get(code.lower())


def data_coverage(area: Any, result_key: str, timeintervall: Any = None) -> dict[str, Any]:
    """Which years have data for a result card's topic at the selected point or region.

    :param area: The map selection (GeoJSON point feature or region feature).
    :param result_key: Card key, e.g. ``precipitation`` or ``temperature · maximum (TMAX)``.
    :param timeintervall: Optional ``[DD.MM.YYYY, DD.MM.YYYY]`` of the request, to count
        the stations that cover it.
    :return: ``{"topic", "scope", "place", "needed", "codes": [...]}``; each code has the
        stations per year, the first and last day with data, the nearest (point) or
        longest-running (region) stations and a suggested time frame.
    :raises CoverageError: For unknown topics, moving platforms or a missing area.
    """
    topic_key, topic, codes = _topic_and_codes(str(result_key))
    if not isinstance(area, dict):
        raise CoverageError("Pick a point or an area on the map first.")

    requested = None
    if isinstance(timeintervall, (list, tuple)) and len(timeintervall) == 2:
        start, end = _parse_dd_mm_yyyy(timeintervall[0]), _parse_dd_mm_yyyy(timeintervall[1])
        if start and end and start <= end:
            requested = (start, end)

    region = area_analysis.region_for_area(area)
    if region is not None:
        west, south, east, north = region.bbox
        by_code = _collect(_search(topic.dataset, f"{north},{west},{south},{east}"), codes, None)
        scope, place, needed, radius_km = "region", region.name, area_analysis.MIN_STATIONS, None
    else:
        geometry = area.get("geometry") or {}
        coords = geometry.get("coordinates") if geometry.get("type") == "Point" else None
        if not coords or len(coords) < 2:
            raise CoverageError("Pick a point or an area on the map first.")
        lon, lat = float(coords[0]), float(coords[1])
        if not (math.isfinite(lat) and math.isfinite(lon)):
            raise CoverageError("The selected point has no valid coordinates.")
        by_code = {code: {} for code in codes}
        radius_km = None
        for radius in POINT_RADII_DEGREES:
            bbox = noaa_api.NOAAClient._make_bounding_box(lat, lon, radius)
            by_code = _collect(_search(topic.dataset, bbox), codes, (lat, lon))
            radius_km = round(radius * 111)
            if any(by_code.values()):
                break
        scope, place, needed = "point", f"{lat:.4f}, {lon:.4f}", 1

    summaries = [
        _code_summary(code, stations, needed, requested, scope == "point")
        for code, stations in by_code.items()
        if stations
    ]
    summaries.sort(key=lambda s: -s["station_count"])
    return {
        "topic": topic_key,
        "result_key": result_key,
        "dataset": topic.dataset,
        "scope": scope,
        "place": place,
        "radius_km": radius_km,
        "needed": needed,
        "requested": [requested[0].isoformat(), requested[1].isoformat()] if requested else None,
        "codes": summaries[:MAX_CODES],
    }


__all__ = ["CoverageError", "data_coverage"]
