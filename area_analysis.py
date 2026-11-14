"""Evaluate one of the predefined regions instead of a single point.

A point request uses the one station nearest to the point. For an area that
would be misleading, so areas are limited to a fixed list of regions
(:data:`REGIONS`) in which NOAA has many stations with long records. Every
station in the region is fetched, binned like a point request and analysed
on its own (one coloured dot per station on the map); the region's series is
the mean of all stations (see :func:`_area_series`).

The regions were chosen with a station count from the NCEI Search Service
for 2015–2024 (stations whose record covers the whole period): every region
has at least 12 temperature and 14 precipitation stations. Wind and the other
optional daily codes are sparse everywhere, so a topic is only evaluated
when the region has at least :data:`MIN_STATIONS` stations for it.

The existing code is used without changes: NOAA requests go through
:class:`noaa_api.NOAAClient`, binning through :mod:`src.task`, and the tools
through :mod:`plot_analysis`.
"""

from __future__ import annotations

import math
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from typing import Any

import noaa_api
import plot_analysis
from src import task

MIN_STATIONS: int = 3
"""Fewest stations with data for a topic before a region is evaluated."""

MAX_STATIONS: int = 30
"""Most stations fetched per topic and region; the longest records win."""

STATIONS_PER_REQUEST: int = 10
"""Stations combined in one NOAA data request, so no response gets too large."""

PARALLEL_REQUESTS: int = 3
"""NOAA data requests sent at the same time; more makes NOAA time out."""

MIN_COVERAGE: float = 0.8
"""Share of the requested range a station's record must cover to be used."""

AREA_DATASETS: frozenset[str] = frozenset(
    {"daily-summaries", "global-summary-of-the-month", "global-summary-of-the-year"}
)
"""Datasets with fixed stations and small enough data to fetch for a whole region.

Hourly data is 24 times larger and marine platforms move, so those topics
stay point-only.
"""


@dataclass(frozen=True)
class Region:
    """A box with enough measuring stations to evaluate an area.

    :param id: Stable id sent by the map as ``area.properties.regionId``.
    :param name: Name shown on the map.
    :param bbox: ``(west, south, east, north)`` in degrees.
    :param temperature_stations: Daily temperature stations covering 2015–2024.
    :param precipitation_stations: Daily precipitation stations covering 2015–2024.
    """

    id: str
    name: str
    bbox: tuple[float, float, float, float]
    temperature_stations: int
    precipitation_stations: int

    def to_dict(self) -> dict[str, Any]:
        """JSON form for ``GET /api/regions`` and the map widget."""
        return {
            "id": self.id,
            "name": self.name,
            "bbox": list(self.bbox),
            "note": (
                f"{self.temperature_stations} temperature / "
                f"{self.precipitation_stations} precipitation stations (2015–2024)"
            ),
        }


REGIONS: tuple[Region, ...] = (
    Region("washington-baltimore", "Washington–Baltimore", (-77.6, 38.6, -76.4, 39.6), 17, 86),
    Region("new-york-city", "New York City", (-74.5, 40.4, -73.5, 41.2), 14, 56),
    Region("boston", "Boston", (-71.6, 42.0, -70.8, 42.7), 16, 29),
    Region("atlanta", "Atlanta", (-84.9, 33.3, -83.9, 34.2), 12, 40),
    Region("chicago", "Chicago", (-88.4, 41.4, -87.4, 42.4), 17, 121),
    Region("minneapolis", "Minneapolis–Saint Paul", (-93.8, 44.6, -92.8, 45.4), 18, 80),
    Region("dallas-fort-worth", "Dallas–Fort Worth", (-97.6, 32.4, -96.4, 33.2), 21, 66),
    Region("denver", "Denver Front Range", (-105.4, 39.4, -104.4, 40.4), 20, 207),
    Region("salt-lake-city", "Salt Lake City", (-112.3, 40.3, -111.5, 41.2), 35, 52),
    Region("phoenix", "Phoenix", (-112.6, 33.1, -111.5, 33.9), 14, 78),
    Region("los-angeles", "Los Angeles", (-118.8, 33.6, -117.6, 34.4), 44, 45),
    Region("san-francisco-bay", "San Francisco Bay", (-122.8, 37.2, -121.8, 38.2), 37, 65),
    Region("seattle", "Seattle–Puget Sound", (-122.8, 47.0, -121.8, 48.0), 18, 71),
    Region("netherlands", "Netherlands", (4.0, 51.5, 6.5, 53.0), 19, 191),
    Region("berlin-brandenburg", "Berlin–Brandenburg", (12.5, 52.0, 14.5, 53.0), 14, 14),
    Region("bavaria", "Bavaria", (10.5, 47.5, 12.5, 49.5), 43, 47),
    Region("southern-sweden", "Southern Sweden", (12.5, 55.3, 14.5, 56.5), 14, 36),
    Region("sydney", "Sydney", (150.6, -34.2, 151.4, -33.5), 19, 48),
)
"""Regions offered by the map's Areas button."""

_REGIONS_BY_ID: dict[str, Region] = {region.id: region for region in REGIONS}

_RISING = "#dc2626"
_RISING_WEAK = "#fca5a5"
_FALLING = "#2563eb"
_FALLING_WEAK = "#93c5fd"
_FLAT = "#94a3b8"


def list_regions() -> list[dict[str, Any]]:
    """All regions as JSON-friendly dicts."""
    return [region.to_dict() for region in REGIONS]


def region_for_area(area: Any) -> Region | None:
    """Return the region a map selection refers to, or ``None`` for a point."""
    if not isinstance(area, dict):
        return None
    properties = area.get("properties")
    if not isinstance(properties, dict) or properties.get("shape") != "region":
        return None
    return _REGIONS_BY_ID.get(str(properties.get("regionId")))


def _parse_day(text: Any) -> date | None:
    try:
        return datetime.fromisoformat(str(text)[:10]).date()
    except ValueError:
        return None


def _find_stations(
    client: noaa_api.NOAAClient,
    region: Region,
    topic: noaa_api.NOAATopic,
    start_date: date,
    end_date: date,
) -> list[dict[str, Any]]:
    """Stations in the region whose record covers most of the requested range.

    Every code is searched on its own and the results are merged: the
    Search Service only returns stations reporting *all* listed codes, and
    most stations report only some of a topic's codes (e.g. TMAX and TMIN
    but not TAVG).

    :return: ``{"id", "name", "coverage"}`` dicts, longest record first,
        at most :data:`MAX_STATIONS`.
    """
    west, south, east, north = region.bbox
    requested_days = (end_date - start_date).days + 1
    found: dict[str, dict[str, Any]] = {}
    for data_types in [(code,) for code in topic.data_types]:
        payload = client._get_json(
            noaa_api.SEARCH_URL,
            {
                "dataset": topic.dataset,
                "dataTypes": ",".join(data_types),
                "startDate": f"{start_date.isoformat()}T00:00:00",
                "endDate": f"{end_date.isoformat()}T23:59:59",
                "bbox": f"{north},{west},{south},{east}",
                "limit": "1000",
                "offset": "0",
            },
        )
        results = payload.get("results", []) if isinstance(payload, dict) else []
        for result in results:
            first, last = _parse_day(result.get("startDate")), _parse_day(result.get("endDate"))
            if first is None or last is None:
                continue
            overlap = (min(last, end_date) - max(first, start_date)).days + 1
            coverage = max(0.0, overlap / requested_days)
            if coverage < MIN_COVERAGE:
                continue
            for station in result.get("stations", []):
                station_id = station.get("id")
                if station_id and coverage > found.get(station_id, {}).get("coverage", -1):
                    found[station_id] = {
                        "id": station_id,
                        "name": station.get("name"),
                        "coverage": round(coverage, 3),
                    }
    ranked = sorted(found.values(), key=lambda s: (-s["coverage"], s["id"]))
    return ranked[:MAX_STATIONS]


def _fetch_records(
    client: noaa_api.NOAAClient,
    topic: noaa_api.NOAATopic,
    station_ids: list[str],
    start_date: date,
    end_date: date,
) -> list[dict[str, Any]]:
    """Observations of all stations, a few stations per request.

    The requests run in parallel (one client each, :data:`PARALLEL_REQUESTS`
    at a time); one request for ten stations and ten years of daily data
    takes 5–20 seconds.
    """
    chunks = [
        station_ids[offset : offset + STATIONS_PER_REQUEST]
        for offset in range(0, len(station_ids), STATIONS_PER_REQUEST)
    ]

    def fetch(chunk: list[str]) -> Any:
        own_client = noaa_api.NOAAClient(
            timeout=client.timeout, max_request_seconds=client.max_request_seconds
        )
        return own_client._get_json(
            noaa_api.BASE_URL,
            {
                "dataset": topic.dataset,
                "dataTypes": ",".join(topic.data_types),
                "stations": ",".join(chunk),
                "startDate": start_date.isoformat(),
                "endDate": end_date.isoformat(),
                "includeStationName": "true",
                "includeStationLocation": "true",
                "format": "json",
                "units": "metric",
            },
        )

    records: list[dict[str, Any]] = []
    with ThreadPoolExecutor(max_workers=PARALLEL_REQUESTS) as pool:
        for payload in pool.map(fetch, chunks):
            for collection in noaa_api._normalize_observations(payload):
                records.extend(collection)
    return records


def _bin_index(label: str, start_date: date, step_days: float) -> int:
    day = datetime.strptime(label, "%d.%m.%Y").date()
    return round((day - start_date).days / step_days)


def _area_series(
    station_bins: dict[str, dict[int, float]],
) -> dict[int, float]:
    """Mean of all stations per interval, robust to stations missing some intervals.

    A plain mean jumps whenever a warm or cold station has a gap. Instead each
    station's values are taken as departures from its own mean; the departures
    are averaged per interval and added to the mean level of all stations.
    """
    station_means = {
        station: sum(bins.values()) / len(bins) for station, bins in station_bins.items() if bins
    }
    if not station_means:
        return {}
    level = sum(station_means.values()) / len(station_means)
    departures: dict[int, list[float]] = {}
    for station, bins in station_bins.items():
        for index, value in bins.items():
            departures.setdefault(index, []).append(value - station_means[station])
    return {
        index: round(level + sum(values) / len(values), 3)
        for index, values in sorted(departures.items())
    }


def _station_colour(trend: dict[str, Any]) -> str:
    slope = trend.get("slope")
    if not trend.get("available") or slope is None or slope == 0:
        return _FLAT
    if slope > 0:
        return _RISING if trend.get("significant") else _RISING_WEAK
    return _FALLING if trend.get("significant") else _FALLING_WEAK


def _error_result(region: Region, message: str) -> dict[str, Any]:
    west, south, east, north = region.bbox
    return {
        "labels": [],
        "values": [],
        "mean": None,
        "coordinates": [round((south + north) / 2, 4), round((west + east) / 2, 4)],
        "station": None,
        "region": region.to_dict(),
        "variables": [],
        "unit": None,
        "error": message,
        "tools": {},
    }


def _evaluate_topic(
    client: noaa_api.NOAAClient,
    region: Region,
    topic_key: str,
    start_date: date,
    end_date: date,
    interval_length: tuple[float, str],
    tools: list[str],
) -> list[tuple[str, dict[str, Any], list[dict[str, Any]]]]:
    """Result cards and station dots for one topic in one region.

    Returns one ``(result key, result, station dots)`` triple per NOAA code
    (e.g. TMAX, TMIN and TAVG separately), see :func:`task.split_by_variable`.
    """
    topic = noaa_api.TOPICS.get(topic_key.lower())
    if topic is None:
        return [(topic_key, _error_result(region, f"Unknown topic {topic_key!r}."), [])]
    if topic.dataset not in AREA_DATASETS:
        return [(topic_key, _error_result(
            region,
            "Area evaluation needs fixed stations with daily, monthly or annual data; "
            "this topic can only be evaluated at a point.",
        ), [])]

    stations = _find_stations(client, region, topic, start_date, end_date)
    if len(stations) < MIN_STATIONS:
        return [(topic_key, _error_result(
            region,
            f"Only {len(stations)} station(s) in {region.name} report this topic for most of the "
            f"selected time range; at least {MIN_STATIONS} are needed for an area. Pick a point instead.",
        ), [])]

    records = _fetch_records(client, topic, [s["id"] for s in stations], start_date, end_date)
    return [
        (result_key, *_evaluate_variable(region, result_key, variable_records,
                                         start_date, end_date, interval_length, tools))
        for result_key, variable_records in task.split_by_variable(topic_key, records)
    ]


def _evaluate_variable(
    region: Region,
    topic_key: str,
    records: list[dict[str, Any]],
    start_date: date,
    end_date: date,
    interval_length: tuple[float, str],
    tools: list[str],
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """Area mean series and station dots for the records of one NOAA code."""
    by_station: dict[str, list[dict[str, Any]]] = {}
    for record in records:
        by_station.setdefault(str(record.get("station")), []).append(record)

    step_days = float(interval_length[0]) * task.INTERVAL_DAYS[interval_length[1]]
    station_bins: dict[str, dict[int, float]] = {}
    station_features: list[dict[str, Any]] = []
    for station_id, station_records in sorted(by_station.items()):
        labels, values = task._bin_records(station_records, start_date, end_date, interval_length)
        if len(values) < 3:
            continue
        indices = [_bin_index(label, start_date, step_days) for label in labels]
        station_bins[station_id] = dict(zip(indices, values))
        trend = plot_analysis.run_tools(indices, values, ["Linear Regression"])["Linear Regression"]
        first = station_records[0]
        try:
            latitude, longitude = float(first["latitude"]), float(first["longitude"])
        except (KeyError, TypeError, ValueError):
            continue
        if not (math.isfinite(latitude) and math.isfinite(longitude)):
            continue
        station_features.append(
            {
                "type": "Feature",
                "geometry": {"type": "Point", "coordinates": [longitude, latitude]},
                "properties": {
                    "kind": "Measuring station",
                    "topic": topic_key,
                    "station": station_id,
                    "name": first.get("name"),
                    "elevation_m": first.get("elevation"),
                    "intervals": len(values),
                    "mean": round(sum(values) / len(values), 3),
                    "slope_per_interval": trend.get("slope"),
                    "p_value": trend.get("p_value"),
                    "significant": trend.get("significant"),
                    "color": _station_colour(trend),
                },
            }
        )

    if len(station_bins) < MIN_STATIONS:
        return _error_result(
            region,
            f"Only {len(station_bins)} station(s) in {region.name} delivered enough values; "
            f"at least {MIN_STATIONS} are needed for an area.",
        ), station_features

    area = _area_series(station_bins)
    indices = list(area)
    values = list(area.values())
    labels = [
        (start_date + timedelta(days=round(index * step_days))).strftime("%d.%m.%Y")
        for index in indices
    ]
    units = {r.get("unit") for r in records}
    result = _error_result(region, "")
    result.update(
        {
            "labels": labels,
            "values": values,
            "mean": round(sum(values) / len(values), 3) if values else None,
            "variables": sorted({str(r["description"]) for r in records if r.get("description")}),
            "unit": units.pop() if len(units) == 1 else None,
            "station_count": len(station_bins),
            "tools": plot_analysis.run_tools(indices, values, tools) if tools else {},
        }
    )
    del result["error"]
    return result, station_features


def process_region_request(user_request: Any, region: Region) -> dict[str, Any]:
    """Evaluate every selected topic in ``region``; same output shape as a point request.

    :param user_request: :class:`interface.UserRequest` with topics, tools,
        time range and interval length.
    :param region: Region picked on the map.
    :return: ``{"topics": {topic: result}, "map_layers": [...]}``. Each topic
        result carries the region's mean series, ``region`` and
        ``station_count``; the map layers are the region outline coloured by
        the area trend and one dot per station coloured by its own trend.
    """
    topics = [topic for topic, checked in user_request.topics.items() if checked]
    tools = [tool for tool, checked in user_request.tools.items() if checked]
    start_date, end_date = user_request.timeintervall
    client = noaa_api.NOAAClient()

    topic_results: dict[str, Any] = {}
    outline_features: list[dict[str, Any]] = []
    station_layers: list[dict[str, Any]] = []
    for topic in topics:
        try:
            evaluated = _evaluate_topic(
                client, region, topic, start_date, end_date, user_request.interval_length, tools
            )
        except (RuntimeError, ValueError) as error:
            evaluated = [(topic, _error_result(region, str(error)), [])]
        for result_key, result, stations in evaluated:
            topic_results[result_key] = result
            if stations:
                station_layers.append(
                    {
                        "type": "geojson",
                        "id": f"area-stations-{result_key}",
                        "pointRadius": 7,
                        "data": {"type": "FeatureCollection", "features": stations},
                    }
                )
            if result.get("values"):
                trend = result["tools"].get("Linear Regression", {})
                outline_features.append(
                    {
                        "type": "Feature",
                        "geometry": {
                            "type": "Polygon",
                            "coordinates": [[
                                [region.bbox[0], region.bbox[1]],
                                [region.bbox[2], region.bbox[1]],
                                [region.bbox[2], region.bbox[3]],
                                [region.bbox[0], region.bbox[3]],
                                [region.bbox[0], region.bbox[1]],
                            ]],
                        },
                        "properties": {
                            "topic": result_key,
                            "region": region.name,
                            "stations": result["station_count"],
                            "mean": result["mean"],
                            "slope_per_interval": trend.get("slope"),
                            "color": _station_colour(trend) if trend else _FLAT,
                        },
                    }
                )

    map_layers: list[dict[str, Any]] = []
    if outline_features:
        map_layers.append(
            {
                "type": "geojson",
                "id": "area-result",
                "fillOpacity": 0.12,
                "data": {"type": "FeatureCollection", "features": outline_features},
            }
        )
    map_layers.extend(station_layers)
    return {"topics": topic_results, "map_layers": map_layers}


__all__ = [
    "REGIONS",
    "Region",
    "list_regions",
    "process_region_request",
    "region_for_area",
]
