"""Evaluate one of the predefined regions, or a box drawn on the map, instead of a single point.

A point request uses the one station nearest to the point. For an area that
would be misleading, so areas are either a fixed list of regions
(:data:`REGIONS`) in which NOAA has many stations with long records, or a box
the user draws (:func:`box_region`, at most :data:`MAX_BOX_KM2`). Before a box
is evaluated, :func:`stations_in_box` lists its stations with data in the
selected time frame, including those that only cover part of it. Every
station in the region is fetched, binned like a point request and analysed
on its own (one coloured dot per station on the map); the region's series is
the mean of all stations (see :func:`_area_series`).

The regions were chosen with a station count for 2015–2024 (stations whose
record covers at least :data:`MIN_COVERAGE` of the period, all databases
together, duplicates removed): every region has at least 7 temperature and
10 precipitation stations. Wind and the other
optional daily codes are sparse everywhere, so a topic is only evaluated
when the region has at least :data:`MIN_STATIONS` stations for it.

Stations come from every database offering the topic in the region
(NOAA everywhere, DWD in Germany, ECCC in Canada, FMI in Finland, ERA5 grid
points from Open-Meteo for the ``*_era5`` topics). Databases often publish the
same station (GHCN-Daily re-publishes many national stations), so the merged
list is cleaned with :func:`station_sources.deduplicate` before the mean is
computed: copies are recognised by WMO number, ECCC climate id and GHCN id,
and, for stations without a shared id, by standing at the same place.

NOAA requests go through :class:`noaa_api.NOAAClient`, binning through
:mod:`src.task`, and the tools through :mod:`plot_analysis`.
"""

from __future__ import annotations

import json
import math
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any

import api_wrapper
import noaa_api
import station_sources
from src import task
from station_sources import Station

MIN_STATIONS: int = 3
"""Fewest stations with data for a topic before a region is evaluated."""

MAX_STATIONS: int = 40
"""Most stations fetched per topic and region (after removing duplicates); the longest records win."""

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

MAX_BOX_KM2: float = 1_000_000.0
"""Largest box drawn on the map that is evaluated (about 1000 km × 1000 km)."""

BOX_REGION_ID: str = "box"
"""``Region.id`` of a box drawn on the map."""

MAX_LISTED_STATIONS: int = 400
"""Most stations :func:`stations_in_box` returns per topic (the longest records first)."""

NOAA_PRIORITY: int = 1
"""NOAA re-publishes national stations; the national original (priority 0) wins a tie."""


@dataclass(frozen=True)
class Region:
    """A box with enough measuring stations to evaluate an area.

    :param id: Stable id sent by the map as ``area.properties.regionId``.
    :param name: Name shown on the map.
    :param bbox: ``(west, south, east, north)`` in degrees.
    :param temperature_stations: Daily temperature stations covering 2015–2024.
    :param precipitation_stations: Daily precipitation stations covering 2015–2024.

    Both counts are of all databases together, after removing duplicates.
    """

    id: str
    name: str
    bbox: tuple[float, float, float, float]
    temperature_stations: int
    precipitation_stations: int

    def to_dict(self) -> dict[str, Any]:
        """JSON form for ``GET /api/regions`` and the map widget."""
        if self.id == BOX_REGION_ID:
            return {"id": self.id, "name": self.name, "bbox": list(self.bbox)}
        return {
            "id": self.id,
            "name": self.name,
            "bbox": list(self.bbox),
            "note": (
                f"{self.temperature_stations} temperature / "
                f"{self.precipitation_stations} precipitation stations (2015–2024, all sources)"
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
    Region("berlin-brandenburg", "Berlin–Brandenburg", (12.5, 52.0, 14.5, 53.0), 15, 52),
    Region("bavaria", "Bavaria", (10.5, 47.5, 12.5, 49.5), 58, 247),
    Region("southern-sweden", "Southern Sweden", (12.5, 55.3, 14.5, 56.5), 14, 36),
    Region("sydney", "Sydney", (150.6, -34.2, 151.4, -33.5), 19, 48),
    Region("toronto", "Toronto", (-80.0, 43.4, -79.0, 44.1), 7, 10),
    Region("montreal", "Montréal", (-74.2, 45.2, -73.2, 45.8), 23, 23),
    Region("vancouver", "Vancouver", (-123.4, 49.0, -122.4, 49.5), 20, 21),
    Region("helsinki", "Helsinki–Uusimaa", (24.0, 59.9, 25.8, 60.7), 21, 21),
)
"""Regions offered by the map's Areas button."""

_REGIONS_BY_ID: dict[str, Region] = {region.id: region for region in REGIONS}

_RISING = "#dc2626"
_RISING_WEAK = "#fca5a5"
_FALLING = "#2563eb"
_FALLING_WEAK = "#93c5fd"
_FLAT = "#94a3b8"

HULL_BORDER_KM: float = 5.0
"""Margin drawn around the outermost stations of an area result."""

_HULL_CIRCLE_POINTS: int = 24
"""Corners of the circle around each station; the hull of all circles is rounded."""


def _counted_stations(region: Region, topic_key: str) -> int | None:
    """Known station count of ``region`` for ``topic_key``; ``None`` when not counted in advance."""
    topic = topic_key.lower()
    if topic == "temperature":
        return region.temperature_stations
    if topic == "precipitation":
        return region.precipitation_stations
    return None


def _area_capable(region: Region, topic_key: str) -> bool:
    """Whether any database can have fixed stations for ``topic_key`` in ``region``.

    Mirrors the checks of :func:`_evaluate_topic` and :func:`_other_source_stations`.
    """
    noaa_topic = noaa_api.TOPICS.get(topic_key.lower())
    if noaa_topic is not None and noaa_topic.dataset in AREA_DATASETS:
        return True
    for key in api_wrapper.providers_for(topic_key):
        if key == "noaa":
            continue
        covers_box = getattr(api_wrapper._PROVIDERS[key], "covers_box", None)
        if covers_box is not None and covers_box(region.bbox):
            return True
    return False


OUTLINES_PATH: Path = Path(__file__).resolve().parent / "data" / "region_outlines.json"
"""Station outlines per region and topic, written by ``python region_outlines.py``."""

_outlines: dict[str, Any] | None = None


def region_outlines() -> dict[str, Any]:
    """``{region id: {topic: GeoJSON polygon}}`` from :data:`OUTLINES_PATH`; empty if missing."""
    global _outlines
    if _outlines is None:
        try:
            data = json.loads(OUTLINES_PATH.read_text(encoding="utf-8"))
            _outlines = data.get("regions", {}) if isinstance(data, dict) else {}
        except (OSError, ValueError):
            _outlines = {}
    return _outlines


VARIABLES_PATH: Path = Path(__file__).resolve().parent / "data" / "region_variables.json"
"""Station count per region and variable, written by ``python region_variables.py``."""

_variables: dict[str, Any] | None = None


def region_variables() -> dict[str, Any]:
    """``{"period": [...], "regions": {region id: {topic: stations}}}``; empty if missing."""
    global _variables
    if _variables is None:
        try:
            data = json.loads(VARIABLES_PATH.read_text(encoding="utf-8"))
            _variables = data if isinstance(data, dict) else {}
        except (OSError, ValueError):
            _variables = {}
    return _variables


def _with_variables(result: dict[str, Any], region: Region) -> dict[str, Any]:
    """Add the variables the region has data for, so a click shows them without a request."""
    data = region_variables()
    known = data.get("regions", {}).get(region.id)
    if isinstance(known, dict):
        result["variables"] = known
        result["variables_period"] = data.get("period")
        result["note"] = f"{result.get('note', '')} · {len(known)} variables with data"
    return result


def _with_outline(result: dict[str, Any], region: Region, topics: list[str]) -> dict[str, Any]:
    """Add the outline of the stations of the first selected topic that has one.

    The map draws it instead of the region's box, so the user sees before
    applying which area the stations actually cover (the area result is
    outlined the same way, around the stations used).
    """
    known = region_outlines().get(region.id, {})
    for topic in [*topics, "temperature", "precipitation"]:
        outline = known.get(topic.lower())
        if outline:
            result["outline"] = outline
            result["outline_topic"] = topic.lower()
            return result
    return result


def _region_for_topics(region: Region, topics: list[str]) -> dict[str, Any] | None:
    """``region`` as a dict with a note for the selected topics, or ``None`` if none can be evaluated there."""
    usable: list[str] = []
    for topic in topics:
        if not _area_capable(region, topic):
            continue
        count = _counted_stations(region, topic)
        if count is None:
            usable.append(f"{topic}: stations checked on evaluation")
        elif count >= MIN_STATIONS:
            usable.append(f"{topic}: {count} stations (2015–2024)")
    if not usable:
        return None
    result = region.to_dict()
    result["note"] = " · ".join(usable)
    return _with_variables(_with_outline(result, region, topics), region)


def list_regions(topics: list[str] | None = None) -> list[dict[str, Any]]:
    """Regions as JSON-friendly dicts.

    :param topics: Selected topics. When given, only regions in which at
        least one of them can be evaluated are listed, and the note names
        those topics; without topics every region is listed.
    """
    if not topics:
        return [_with_variables(_with_outline(region.to_dict(), region, []), region) for region in REGIONS]
    listed = (_region_for_topics(region, topics) for region in REGIONS)
    return [region for region in listed if region is not None]


def region_for_area(area: Any) -> Region | None:
    """Return the region a map selection refers to (a predefined region or a drawn box), or ``None`` for a point."""
    if not isinstance(area, dict):
        return None
    properties = area.get("properties")
    if not isinstance(properties, dict):
        return None
    if properties.get("shape") == "box":
        return box_region(area)
    if properties.get("shape") != "region":
        return None
    return _REGIONS_BY_ID.get(str(properties.get("regionId")))


def box_area_km2(bbox: tuple[float, float, float, float]) -> float:
    """Area of a longitude/latitude box on the sphere in km²."""
    west, south, east, north = bbox
    radius = 6371.0088
    return abs(
        math.radians(east - west) * (math.sin(math.radians(north)) - math.sin(math.radians(south)))
    ) * radius * radius


def _box_bbox(area: dict[str, Any]) -> tuple[float, float, float, float] | None:
    """``(west, south, east, north)`` of a drawn box: its ``bbox``, else the extent of its ring."""
    bbox = area.get("bbox")
    if isinstance(bbox, (list, tuple)) and len(bbox) == 4:
        try:
            values = tuple(float(v) for v in bbox)
        except (TypeError, ValueError):
            values = None
        if values and all(math.isfinite(v) for v in values):
            return values  # type: ignore[return-value]
    geometry = area.get("geometry") or {}
    try:
        ring = geometry["coordinates"][0]
        lons = [float(p[0]) for p in ring]
        lats = [float(p[1]) for p in ring]
    except (KeyError, IndexError, TypeError, ValueError):
        return None
    if not lons:
        return None
    return (min(lons), min(lats), max(lons), max(lats))


def box_region(area: Any) -> Region | None:
    """The :class:`Region` of a box drawn on the map, or ``None`` if it has no usable extent.

    Boxes that cross the antimeridian or exceed :data:`MAX_BOX_KM2` are still
    returned; :func:`box_problem` names what is wrong with them.
    """
    if not isinstance(area, dict):
        return None
    bbox = _box_bbox(area)
    if bbox is None:
        return None
    west, south, east, north = bbox
    return Region(
        BOX_REGION_ID,
        "the drawn box",
        (round(west, 4), round(max(south, -90.0), 4), round(east, 4), round(min(north, 90.0), 4)),
        0,
        0,
    )


def box_problem(region: Region) -> str | None:
    """Why a drawn box cannot be evaluated, or ``None`` when it can."""
    if region.id != BOX_REGION_ID:
        return None
    west, south, east, north = region.bbox
    if west > east:
        return "The box crosses the 180° meridian; draw it on one side of it."
    if east - west <= 0 or north - south <= 0:
        return "The box has no size; drag across the map to draw it."
    size = box_area_km2(region.bbox)
    if size > MAX_BOX_KM2:
        return (
            f"The box covers about {size:,.0f} km²; draw one of at most "
            f"{MAX_BOX_KM2:,.0f} km² (about 1000 km × 1000 km)."
        )
    return None


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
    min_coverage: float = MIN_COVERAGE,
) -> list[Station]:
    """NOAA stations in the region whose record covers at least ``min_coverage`` of the requested range.

    Every code is searched on its own and the results are merged: the
    Search Service only returns stations reporting *all* listed codes, and
    most stations report only some of a topic's codes (e.g. TMAX and TMIN
    but not TAVG).

    :return: Stations with ``coverage`` set and only their GHCN id as
        identity (see :func:`_with_ghcnd_identities`).
    """
    west, south, east, north = region.bbox
    requested_days = (end_date - start_date).days + 1
    found: dict[str, Station] = {}
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
            if coverage <= 0 or coverage < min_coverage:
                continue
            points = result.get("boundingPoints") or [{}]
            coordinates = points[0].get("coordinates") or []
            if len(coordinates) < 2:
                continue
            for station in result.get("stations", []):
                station_id = station.get("id")
                if not station_id:
                    continue
                if station_id in found and found[station_id].coverage >= coverage:
                    continue
                found[station_id] = Station(
                    source="NOAA",
                    id=station_id,
                    name=str(station.get("name") or station_id),
                    latitude=float(coordinates[1]),
                    longitude=float(coordinates[0]),
                    first_date=first,
                    last_date=last,
                    ids=frozenset({f"ghcnd:{station_id}"}),
                    coverage=round(coverage, 3),
                    priority=NOAA_PRIORITY,
                )
    return list(found.values())


def _with_ghcnd_identities(stations: list[Station]) -> list[Station]:
    """Add WMO number and ECCC climate id to NOAA stations (see :func:`station_sources.ghcnd_identity_keys`)."""
    from dataclasses import replace

    return [replace(s, ids=station_sources.ghcnd_identity_keys(s.id)) for s in stations]


def _other_source_stations(
    region: Region, topic_key: str, start_date: date, end_date: date, min_coverage: float = MIN_COVERAGE
) -> tuple[list[Station], dict[str, Any], list[str]]:
    """Stations of all non-NOAA databases offering the topic in the region, covering at least ``min_coverage``.

    :return: ``(stations, {source name: client}, [error messages])``.
    """
    stations: list[Station] = []
    clients: dict[str, Any] = {}
    errors: list[str] = []
    for key in api_wrapper.providers_for(topic_key):
        if key == "noaa":
            continue
        client_type = api_wrapper._PROVIDERS[key]
        covers_box = getattr(client_type, "covers_box", None)
        if covers_box is None or not covers_box(region.bbox):
            continue
        client = client_type()
        try:
            found = client.stations(region.bbox, topic_key.lower(), start_date, end_date)
        except (RuntimeError, ValueError, OSError) as error:
            errors.append(f"{client.SOURCE}: {error}")
            continue
        found = [s for s in found if s.coverage > 0 and s.coverage >= min_coverage]
        if found:
            clients[client.SOURCE] = client
            stations.extend(found)
    return stations, clients, errors


def _gather_stations(
    client: noaa_api.NOAAClient,
    region: Region,
    topic_key: str,
    start_date: date,
    end_date: date,
) -> tuple[list[Station], list[tuple[Station, Station]], dict[str, Any], list[str]]:
    """Stations of all databases for the topic, duplicates removed, best :data:`MAX_STATIONS`.

    :return: ``(stations, dropped duplicates, {source: client}, errors)``.
    """
    noaa_topic = noaa_api.TOPICS.get(topic_key.lower())
    noaa_stations: list[Station] = []
    errors: list[str] = []
    if noaa_topic is not None and noaa_topic.dataset in AREA_DATASETS:
        try:
            noaa_stations = _find_stations(client, region, noaa_topic, start_date, end_date)
        except (RuntimeError, ValueError) as error:
            errors.append(f"NOAA: {error}")
    others, clients, other_errors = _other_source_stations(region, topic_key, start_date, end_date)
    errors += other_errors
    if others and noaa_stations:
        noaa_stations = _with_ghcnd_identities(noaa_stations)
    kept, dropped = station_sources.deduplicate([*noaa_stations, *others])
    return _spread(kept, MAX_STATIONS), dropped, clients, errors


def _spread(stations: list[Station], count: int) -> list[Station]:
    """At most ``count`` stations, the longest records first, spread over the region.

    Stations are taken in order of coverage; within the same coverage the
    next one is always the station farthest from all chosen ones, so a dense
    network (hundreds of DWD rain gauges) does not end up as one cluster.
    """
    ranked = sorted(stations, key=lambda s: (-round(s.coverage, 2), s.priority, s.source, s.id))
    if len(ranked) <= count:
        return ranked
    chosen: list[Station] = []
    for coverage in sorted({round(s.coverage, 2) for s in ranked}, reverse=True):
        group = [s for s in ranked if round(s.coverage, 2) == coverage]
        while group and len(chosen) < count:
            if not chosen:
                pick = group[0]
            else:
                pick = max(
                    group,
                    key=lambda s: min(
                        station_sources.distance_km(s.latitude, s.longitude, c.latitude, c.longitude)
                        for c in chosen
                    ),
                )
            chosen.append(pick)
            group.remove(pick)
        if len(chosen) >= count:
            break
    return chosen


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
                records.extend({**record, "source": "NOAA"} for record in collection)
    return records


def _fetch_all_records(
    client: noaa_api.NOAAClient,
    topic_key: str,
    stations: list[Station],
    clients: dict[str, Any],
    start_date: date,
    end_date: date,
) -> list[dict[str, Any]]:
    """Observations of all stations, every database in its own thread."""
    by_source: dict[str, list[Station]] = {}
    for station in stations:
        by_source.setdefault(station.source, []).append(station)

    def fetch(source: str) -> list[dict[str, Any]]:
        group = by_source[source]
        if source == "NOAA":
            topic = noaa_api.TOPICS[topic_key.lower()]
            return _fetch_records(client, topic, [s.id for s in group], start_date, end_date)
        return clients[source].fetch(group, topic_key.lower(), start_date, end_date)

    records: list[dict[str, Any]] = []
    sources = list(by_source)
    with ThreadPoolExecutor(max_workers=max(1, len(sources))) as pool:
        futures = [pool.submit(fetch, source) for source in sources]
        failures: list[str] = []
        for source, future in zip(sources, futures):
            try:
                records.extend(future.result())
            except Exception as error:  # noqa: BLE001 - keep the other databases' stations
                failures.append(f"{source}: {error}")
    if not records and failures:
        raise RuntimeError("; ".join(failures))
    return records


AREA_ITERATIONS: int = 20
"""Rounds of the joint estimate of the area series and the station offsets."""


def _area_series(
    station_bins: dict[str, dict[int, float]],
) -> dict[int, float]:
    """Mean of all stations per interval, robust to stations entering or leaving.

    Each station is modelled as ``area(t) + offset(station)``. A plain mean
    jumps whenever a warm or cold station has a gap; taking each station's
    departure from *its own* mean is still biased when stations only cover
    part of the range (a station measuring only the warmer late years gets
    a high mean, so its departures are too small: −19 % of a true trend in
    a test). Offsets and area series are therefore estimated together, by
    alternating ``offset = mean(value − area)`` and
    ``area = mean(value − offset)``; the offsets are centred so the area
    keeps the mean level of the stations.
    """
    stations = {station: bins for station, bins in station_bins.items() if bins}
    if not stations:
        return {}
    offsets = {station: sum(bins.values()) / len(bins) for station, bins in stations.items()}
    centre = sum(offsets.values()) / len(offsets)
    offsets = {station: value - centre for station, value in offsets.items()}
    area: dict[int, float] = {}
    for _ in range(AREA_ITERATIONS):
        collected: dict[int, list[float]] = {}
        for station, bins in stations.items():
            for index, value in bins.items():
                collected.setdefault(index, []).append(value - offsets[station])
        area = {index: sum(values) / len(values) for index, values in collected.items()}
        new_offsets = {
            station: sum(value - area[index] for index, value in bins.items()) / len(bins)
            for station, bins in stations.items()
        }
        centre = sum(new_offsets.values()) / len(new_offsets)
        new_offsets = {station: value - centre for station, value in new_offsets.items()}
        change = max(abs(new_offsets[s] - offsets[s]) for s in stations)
        offsets = new_offsets
        if change < 1e-6:
            break
    collected = {}
    for station, bins in stations.items():
        for index, value in bins.items():
            collected.setdefault(index, []).append(value - offsets[station])
    return {
        index: round(sum(values) / len(values), 3)
        for index, values in sorted(collected.items())
    }


def _source_counts(
    by_station: dict[str, list[dict[str, Any]]], station_bins: dict[str, dict[int, float]]
) -> dict[str, int]:
    """Number of stations each database contributed to the area mean."""
    counts: dict[str, int] = {}
    for station_id in station_bins:
        source = str(by_station[station_id][0].get("source", "NOAA"))
        counts[source] = counts.get(source, 0) + 1
    return dict(sorted(counts.items()))


def _station_colour(trend: dict[str, Any]) -> str:
    slope = trend.get("slope")
    if not trend.get("available") or slope is None or slope == 0:
        return _FLAT
    if slope > 0:
        return _RISING if trend.get("significant") else _RISING_WEAK
    return _FALLING if trend.get("significant") else _FALLING_WEAK


def _convex_hull(points: list[tuple[float, float]]) -> list[tuple[float, float]]:
    """Convex hull, counter-clockwise, without repeating the first point (monotone chain)."""
    unique = sorted(set(points))
    if len(unique) < 3:
        return unique

    def cross(o: tuple[float, float], a: tuple[float, float], b: tuple[float, float]) -> float:
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])

    lower: list[tuple[float, float]] = []
    for point in unique:
        while len(lower) >= 2 and cross(lower[-2], lower[-1], point) <= 0:
            lower.pop()
        lower.append(point)
    upper: list[tuple[float, float]] = []
    for point in reversed(unique):
        while len(upper) >= 2 and cross(upper[-2], upper[-1], point) <= 0:
            upper.pop()
        upper.append(point)
    return lower[:-1] + upper[:-1]


def _station_hull(stations: list[dict[str, Any]], region: Region) -> dict[str, Any]:
    """Polygon around the station features used for an area result (see :func:`hull_polygon`)."""
    return hull_polygon([tuple(f["geometry"]["coordinates"][:2]) for f in stations], region)


def hull_polygon(positions: list[tuple[float, float]], region: Region) -> dict[str, Any]:
    """Polygon around station positions ``(longitude, latitude)``, with a border.

    Each station is replaced by a circle of :data:`HULL_BORDER_KM` and the
    convex hull of all circles is returned, so the outline keeps the same
    distance to the outermost stations and its corners are rounded. Without
    station positions the region's box is returned.
    """
    circle: list[tuple[float, float]] = []
    for longitude, latitude in positions:
        degrees_latitude = HULL_BORDER_KM / 111.32
        degrees_longitude = degrees_latitude / max(math.cos(math.radians(latitude)), 0.01)
        for k in range(_HULL_CIRCLE_POINTS):
            angle = 2 * math.pi * k / _HULL_CIRCLE_POINTS
            circle.append((
                round(longitude + degrees_longitude * math.cos(angle), 5),
                round(latitude + degrees_latitude * math.sin(angle), 5),
            ))
    hull = _convex_hull(circle)
    if len(hull) < 3:
        west, south, east, north = region.bbox
        hull = [(west, south), (east, south), (east, north), (west, north)]
    ring = [[x, y] for x, y in hull]
    return {"type": "Polygon", "coordinates": [ring + [ring[0]]]}


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
    noaa_topic = noaa_api.TOPICS.get(topic_key.lower())
    other_keys = [key for key in api_wrapper.providers_for(topic_key) if key != "noaa"]
    if noaa_topic is None and not other_keys:
        return [(topic_key, _error_result(region, f"Unknown topic {topic_key!r}."), [])]
    if noaa_topic is not None and noaa_topic.dataset not in AREA_DATASETS and not other_keys:
        return [(topic_key, _error_result(
            region,
            "Area evaluation needs fixed stations with daily, monthly or annual data; "
            "this topic can only be evaluated at a point.",
        ), [])]

    stations, dropped, clients, errors = _gather_stations(client, region, topic_key, start_date, end_date)
    if len(stations) < MIN_STATIONS:
        reason = f" ({'; '.join(errors)})" if errors else ""
        return [(topic_key, _error_result(
            region,
            f"Only {len(stations)} station(s) in {region.name} report this topic for most of the "
            f"selected time range; at least {MIN_STATIONS} are needed for an area. Pick a point instead."
            + reason,
        ), [])]

    records = _fetch_all_records(client, topic_key, stations, clients, start_date, end_date)
    # Same units as a point request: precipitation totals as mm/day, rain-day
    # counts as % of days, DAPR day counts folded into MDPR.
    records = task.precipitation_as_density(records)
    evaluated = []
    for result_key, variable_records in task.drop_sparse_variables(task.split_by_variable(topic_key, records)):
        result, features = _evaluate_variable(
            region, result_key, variable_records, start_date, end_date, interval_length, tools
        )
        result["duplicates_removed"] = len(dropped)
        result["duplicates"] = [
            {"dropped": f"{copy.source} {copy.id}", "kept": f"{twin.source} {twin.id}"}
            for copy, twin in dropped
        ]
        if errors:
            result["source_errors"] = errors
        evaluated.append((result_key, result, features))
    return evaluated


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
    if records and all(task.is_direction(str(r.get("description") or "")) for r in records):
        return _error_result(
            region,
            "Wind directions wrap around at 360°, so an area mean or trend of them is not "
            "meaningful. Pick a point to see the direction at one station.",
        ), []
    by_station: dict[str, list[dict[str, Any]]] = {}
    for record in records:
        by_station.setdefault(str(record.get("station")), []).append(record)

    step_days = float(interval_length[0]) * task.INTERVAL_DAYS[interval_length[1]]
    station_bins: dict[str, dict[int, float]] = {}
    station_features: list[dict[str, Any]] = []
    for station_id, station_records in sorted(by_station.items()):
        indices, labels, values = task.bin_records_indexed(
            station_records, start_date, end_date, interval_length
        )
        if len(values) < 3:
            continue
        station_bins[station_id] = dict(zip(indices, values))
        trend = task.run_series_tools(indices, values, ["Linear Regression"], interval_length)[
            "Linear Regression"
        ]
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
                    "Station": f"{first.get('name') or station_id} ({first.get('source', 'NOAA')} {station_id})",
                    **(
                        {"Elevation": f"{first.get('elevation'):.0f} m"}
                        if isinstance(first.get("elevation"), (int, float))
                        else {}
                    ),
                    **{
                        key: value
                        for key, value in task.popup_properties(
                            topic_key,
                            round(sum(values) / len(values), 3),
                            first.get("unit"),
                            len(values),
                            {"Linear Regression": trend},
                        ).items()
                        if key != "Result"
                    },
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
        task.bin_bounds(index, start_date, interval_length)[0].strftime("%d.%m.%Y")
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
            "unit": next(iter(units)) if len(units) == 1 else None,
            "station_count": len(station_bins),
            "sources": _source_counts(by_station, station_bins),
            "tools": task.run_series_tools(
                indices, values, tools, interval_length, labels,
                direction=all(task.is_direction(str(r.get("description") or "")) for r in records),
            ),
            "events": _area_events(labels, values, records, units, step_days),
        }
    )
    del result["error"]
    return result, station_features


def _area_events(
    labels: list[str], values: list[float], records: list[dict[str, Any]], units: set[Any], step_days: float
) -> list[dict[str, Any]]:
    """Notable events of the area mean series (see :mod:`events`); never raises."""
    import events

    codes = sorted({str(r.get("description") or "") for r in records})
    unit = next(iter(units)) if len(units) == 1 else None
    try:
        return events.events_for_series(labels, values, codes[0] if len(codes) == 1 else "", unit, step_days)
    except Exception:  # noqa: BLE001 - events are extra
        return []


_box_cache: dict[tuple[Any, ...], dict[str, Any]] = {}
_BOX_CACHE_SIZE = 64


def stations_in_box(
    bbox: tuple[float, float, float, float], topic_key: str, start_date: date, end_date: date
) -> dict[str, Any]:
    """Stations in a drawn box with any data for ``topic_key`` between the two dates.

    Unlike an evaluation, stations that only cover part of the time frame are
    listed too, with the part they cover (``from``/``to``) and whether they
    cover enough (:data:`MIN_COVERAGE`) to be used in the area mean (``used``).
    Copies of the same station in several databases are listed once.

    :return: ``{"topic", "stations": [...], "total", "complete", "partial",
        "usable", "needed", "errors", "point_only"}``; ``stations`` holds at
        most :data:`MAX_LISTED_STATIONS`, the longest records first.
    """
    key = (tuple(round(v, 3) for v in bbox), topic_key.lower(), start_date, end_date)
    cached = _box_cache.get(key)
    if cached is not None:
        return cached

    region = Region(BOX_REGION_ID, "the drawn box", bbox, 0, 0)
    result: dict[str, Any] = {
        "topic": topic_key,
        "stations": [],
        "total": 0,
        "complete": 0,
        "partial": 0,
        "usable": 0,
        "needed": MIN_STATIONS,
        "min_coverage": MIN_COVERAGE,
        "errors": [],
        "point_only": False,
    }
    problem = box_problem(region)
    if problem:
        result["errors"].append(problem)
        return result
    if not _area_capable(region, topic_key):
        result["point_only"] = True
        return result

    noaa_topic = noaa_api.TOPICS.get(topic_key.lower())
    noaa_stations: list[Station] = []
    errors: list[str] = []
    if noaa_topic is not None and noaa_topic.dataset in AREA_DATASETS:
        try:
            noaa_stations = _find_stations(
                noaa_api.NOAAClient(), region, noaa_topic, start_date, end_date, min_coverage=0.0
            )
        except (RuntimeError, ValueError) as error:
            errors.append(f"NOAA: {error}")
    others, _clients, other_errors = _other_source_stations(
        region, topic_key, start_date, end_date, min_coverage=0.0
    )
    errors += other_errors
    if others and noaa_stations:
        noaa_stations = _with_ghcnd_identities(noaa_stations)
    kept, _dropped = station_sources.deduplicate([*noaa_stations, *others])

    ranked = sorted(kept, key=lambda s: (-s.coverage, s.priority, s.name))
    listed = []
    for station in ranked[:MAX_LISTED_STATIONS]:
        first = station.first_date or start_date
        last = station.last_date or end_date
        listed.append(
            {
                "source": station.source,
                "id": station.id,
                "name": station.name,
                "latitude": round(station.latitude, 4),
                "longitude": round(station.longitude, 4),
                "first": first.isoformat(),
                "last": last.isoformat(),
                "from": max(first, start_date).isoformat(),
                "to": min(last, end_date).isoformat(),
                "coverage": round(station.coverage, 3),
                "used": station.coverage >= MIN_COVERAGE,
            }
        )
    result.update(
        {
            "stations": listed,
            "total": len(kept),
            "complete": sum(1 for s in kept if s.coverage >= 0.999),
            "partial": sum(1 for s in kept if s.coverage < 0.999),
            "usable": sum(1 for s in kept if s.coverage >= MIN_COVERAGE),
            "errors": errors,
        }
    )
    if not errors:
        if len(_box_cache) >= _BOX_CACHE_SIZE:
            _box_cache.pop(next(iter(_box_cache)))
        _box_cache[key] = result
    return result


def process_region_request(user_request: Any, region: Region) -> dict[str, Any]:
    """Evaluate every selected topic in ``region``; same output shape as a point request.

    :param user_request: :class:`interface.UserRequest` with topics, tools,
        time range and interval length.
    :param region: Region picked on the map.
    :return: ``{"topics": {topic: result}, "map_layers": [...]}``. Each topic
        result carries the region's mean series, ``region`` and
        ``station_count``; the map layers are the outline around the stations
        used (convex hull with a border, see :func:`_station_hull`) coloured by
        the area trend and one dot per station coloured by its own trend.
    """
    topics = [topic for topic, checked in user_request.topics.items() if checked]
    tools = [tool for tool, checked in user_request.tools.items() if checked]
    start_date, end_date = user_request.timeintervall
    problem = box_problem(region)
    if problem:
        return {"topics": {topic: _error_result(region, problem) for topic in topics}, "map_layers": []}
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
                        "geometry": _station_hull(stations, region),
                        "properties": {
                            **task.popup_properties(
                                f"{result_key} · {region.name}",
                                result["mean"],
                                result.get("unit"),
                                len(result["values"]),
                                result["tools"],
                                result.get("events"),
                            ),
                            "Stations": result["station_count"],
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
    "box_problem",
    "box_region",
    "list_regions",
    "process_region_request",
    "region_for_area",
    "stations_in_box",
]
