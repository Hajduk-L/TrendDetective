"""Shared pieces of the additional data sources (DWD, ECCC, FMI, Open-Meteo, PolarWatch).

Every source returns the same record shape as :mod:`noaa_api`::

    {"date", "station", "latitude", "longitude", "elevation", "name",
     "value", "description", "unit", "source"}

Measured quantities that NOAA also has use NOAA's lowercase codes as
``description`` (``tmax``, ``tmin``, ``tavg``, ``prcp``, ``snow``, ``snwd``,
``awnd``, ``wsfg``) and NOAA's metric units, so a DWD maximum temperature and
a GHCN ``TMAX`` end up in the same series.

Several databases often report the same physical station (GHCN-Daily, for
example, re-publishes many DWD, ECCC and FMI stations). :func:`deduplicate`
removes those copies before an area mean is computed. Stations are matched by
their identifiers first (WMO number, ECCC climate id, GHCN id, ...); see
:func:`ghcnd_identity_keys` for how GHCN ids are translated. Many GHCN
stations carry an ECA&D number and no WMO number, so as a last resort two
stations of *different* databases that stand at the same place
(:data:`COLOCATED_KM`, :data:`COLOCATED_ELEVATION_M`) also count as one.
"""

from __future__ import annotations

import json
import math
import time
from dataclasses import dataclass, field, replace
from datetime import date
from pathlib import Path
from typing import Any, Iterable, Iterator

import requests

CACHE_DIR: Path = Path("data") / "cache"
"""Downloaded station lists and DWD files are kept here between requests."""

COLOCATED_KM: float = 1.0
"""Stations of different databases closer than this are treated as one station."""

COLOCATED_ELEVATION_M: float = 25.0
"""…unless both report an elevation and they differ by more than this."""

GHCND_STATIONS_URL: str = "https://www.ncei.noaa.gov/pub/data/ghcn/daily/ghcnd-stations.txt"
"""GHCN-Daily station list; its last column is the station's WMO number."""

GHCND_STATIONS_MAX_AGE_DAYS: float = 30.0


class SourceError(RuntimeError):
    """A data source rejected or failed a request, or has no matching station."""


@dataclass(frozen=True)
class Station:
    """One measuring station (or model grid cell) of any data source.

    :param source: Display name of the database, e.g. ``"DWD"``.
    :param id: Station id as written into the records, prefixed with the source
        where the bare id could collide with another database (``"DWD:00403"``).
    :param ids: Identity keys used to find the same station in other
        databases, e.g. ``{"dwd:00403", "wmo:10381"}``.
    :param coverage: Share of the requested date range the station's record
        covers (0–1); filled in by the caller.
    :param priority: Lower wins when two databases report the same station.
    """

    source: str
    id: str
    name: str
    latitude: float
    longitude: float
    elevation: float | None = None
    first_date: date | None = None
    last_date: date | None = None
    ids: frozenset[str] = field(default_factory=frozenset)
    coverage: float = 1.0
    priority: int = 0
    extra: dict[str, Any] = field(default_factory=dict, compare=False, hash=False)

    def coverage_of(self, start_date: date, end_date: date) -> float:
        """Share of ``start_date``–``end_date`` inside the station's record."""
        if self.first_date is None or self.last_date is None:
            return 1.0
        requested = (end_date - start_date).days + 1
        overlap = (min(self.last_date, end_date) - max(self.first_date, start_date)).days + 1
        return max(0.0, overlap / requested)

    def record(self, day: str, value: float, description: str, unit: str | None) -> dict[str, Any]:
        """One observation in the shared record format."""
        return {
            "date": day,
            "station": self.id,
            "latitude": self.latitude,
            "longitude": self.longitude,
            "elevation": self.elevation,
            "name": self.name,
            "value": value,
            "description": description,
            "unit": unit,
            "source": self.source,
        }


def with_coverage(station: Station, start_date: date, end_date: date) -> Station:
    """Copy of ``station`` with :attr:`Station.coverage` set for the date range."""
    return replace(station, coverage=round(station.coverage_of(start_date, end_date), 3))


def distance_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Great-circle distance between two points in kilometres."""
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    d_phi = phi2 - phi1
    d_lambda = math.radians(lon2 - lon1)
    a = math.sin(d_phi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(d_lambda / 2) ** 2
    return 6371.0088 * 2 * math.asin(math.sqrt(min(1.0, a)))


def in_box(latitude: float, longitude: float, bbox: tuple[float, float, float, float]) -> bool:
    """Whether a point lies in a ``(west, south, east, north)`` box."""
    west, south, east, north = bbox
    return south <= latitude <= north and west <= longitude <= east


def boxes_overlap(
    a: tuple[float, float, float, float], b: tuple[float, float, float, float]
) -> bool:
    """Whether two ``(west, south, east, north)`` boxes intersect."""
    return a[0] <= b[2] and b[0] <= a[2] and a[1] <= b[3] and b[1] <= a[3]


def point_box(latitude: float, longitude: float, radius_km: float) -> tuple[float, float, float, float]:
    """A ``(west, south, east, north)`` box reaching ``radius_km`` around a point."""
    d_lat = radius_km / 111.0
    d_lon = radius_km / (111.0 * max(0.05, math.cos(math.radians(latitude))))
    return (
        max(-180.0, longitude - d_lon),
        max(-90.0, latitude - d_lat),
        min(180.0, longitude + d_lon),
        min(90.0, latitude + d_lat),
    )


# --------------------------------------------------------------------------- HTTP


_SESSION = requests.Session()
_SESSION.headers["User-Agent"] = "TrendDetective/1.0 (climate trend explorer)"


def http_get(
    url: str,
    params: dict[str, Any] | list[tuple[str, Any]] | None = None,
    *,
    source: str,
    timeout: float = 60.0,
    max_seconds: float = 180.0,
) -> bytes:
    """GET ``url`` and return the body, with a deadline on the whole transfer.

    :raises SourceError: On connection errors, HTTP errors or a body that
        keeps trickling in for longer than ``max_seconds``.
    """
    deadline = time.monotonic() + max_seconds
    response: requests.Response | None = None
    try:
        response = _SESSION.get(url, params=params, timeout=timeout, stream=True)
        chunks: list[bytes] = []
        for chunk in response.iter_content(chunk_size=64 * 1024):
            chunks.append(chunk)
            if time.monotonic() > deadline:
                raise SourceError(
                    f"{source} did not finish sending data within {max_seconds:.0f} seconds. "
                    "Try a shorter time range."
                )
        body = b"".join(chunks)
        if response.status_code >= 400:
            preview = body.decode("utf-8", "replace")[:300]
            raise SourceError(f"{source} request failed ({response.status_code}): {preview}")
        return body
    except requests.RequestException as exc:
        raise SourceError(f"{source} request failed: {exc}") from exc
    finally:
        if response is not None:
            response.close()


def http_get_json(url: str, params: Any = None, *, source: str, **kwargs: Any) -> Any:
    """:func:`http_get` and decode JSON."""
    body = http_get(url, params, source=source, **kwargs)
    try:
        return json.loads(body)
    except ValueError as exc:
        raise SourceError(f"{source} returned no JSON: {body[:300]!r}") from exc


def cached_download(
    url: str, path: Path, *, source: str, max_age_days: float, **kwargs: Any
) -> Path:
    """Download ``url`` to ``path`` unless a copy younger than ``max_age_days`` exists."""
    if path.exists() and time.time() - path.stat().st_mtime < max_age_days * 86400:
        return path
    body = http_get(url, source=source, **kwargs)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".part")
    temporary.write_bytes(body)
    temporary.replace(path)
    return path


# ------------------------------------------------------------- station identities


_GHCND_WMO: dict[str, str] | None = None


def _ghcnd_wmo_numbers() -> dict[str, str]:
    """GHCN-Daily id → WMO number, from the cached GHCN station list."""
    global _GHCND_WMO
    if _GHCND_WMO is None:
        path = cached_download(
            GHCND_STATIONS_URL,
            CACHE_DIR / "ghcnd-stations.txt",
            source="NOAA",
            max_age_days=GHCND_STATIONS_MAX_AGE_DAYS,
        )
        numbers: dict[str, str] = {}
        with path.open(encoding="latin-1") as lines:
            for line in lines:
                wmo = line[80:85].strip()
                if wmo.isdigit():
                    numbers[line[0:11]] = wmo
        _GHCND_WMO = numbers
    return _GHCND_WMO


def ghcnd_identity_keys(ghcnd_id: str) -> frozenset[str]:
    """Identity keys of a GHCN-Daily station.

    * every station: ``ghcnd:<id>``
    * the WMO number from the GHCN station list: ``wmo:<number>``
    * Canadian ``CAN0xxxxxxx`` ids end with the ECCC climate id: ``eccc:<id>``

    If the station list cannot be downloaded, only the id-based keys are
    returned (co-location still catches most duplicates).
    """
    keys = {f"ghcnd:{ghcnd_id}"}
    if ghcnd_id.startswith("CAN0") and len(ghcnd_id) == 11:
        keys.add(f"eccc:{ghcnd_id[4:]}")
    try:
        wmo = _ghcnd_wmo_numbers().get(ghcnd_id)
    except (SourceError, OSError):
        wmo = None
    if wmo:
        keys.add(f"wmo:{int(wmo):05d}")
    return frozenset(keys)


def wmo_key(number: Any) -> str | None:
    """``wmo:NNNNN`` for a WMO number given as text or int, else ``None``."""
    text = str(number or "").strip()
    return f"wmo:{int(text):05d}" if text.isdigit() and int(text) > 0 else None


def same_station(a: Station, b: Station) -> bool:
    """Whether two stations of the database lists are one physical station."""
    if a.ids & b.ids:
        return True
    if a.source == b.source:
        return False  # one database never lists a station twice
    if distance_km(a.latitude, a.longitude, b.latitude, b.longitude) > COLOCATED_KM:
        return False
    if a.elevation is not None and b.elevation is not None:
        return abs(a.elevation - b.elevation) <= COLOCATED_ELEVATION_M
    return True


def deduplicate(stations: Iterable[Station]) -> tuple[list[Station], list[tuple[Station, Station]]]:
    """Keep one copy of every physical station.

    Of two copies, the one covering more of the requested range is kept; on a
    tie the database with the lower :attr:`Station.priority` (the national
    weather service that measured it) wins.

    :return: ``(kept stations, [(dropped copy, kept station), ...])``.
    """
    kept: list[Station] = []
    dropped: list[tuple[Station, Station]] = []
    for station in sorted(stations, key=lambda s: (-round(s.coverage, 3), s.priority, s.source, s.id)):
        twin = next((other for other in kept if same_station(station, other)), None)
        if twin is None:
            kept.append(station)
        else:
            dropped.append((station, twin))
    return kept, dropped


# ------------------------------------------------------------ point-request files


def save_and_iterate(
    collections: list[list[dict[str, Any]]], path: Path
) -> list[Iterator[dict[str, Any]]]:
    """Save record collections like :mod:`noaa_api` does and return one iterator each."""
    from noaa_api import NOAAClient  # local import: noaa_api is the heavier module

    collections = [collection for collection in collections if collection]
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as output_file:
        json.dump(collections, output_file, ensure_ascii=False, indent=2)
        output_file.write("\n")
    return [
        NOAAClient._iter_measurements(path, collection[0]["description"])
        for collection in collections
    ]


def group_by_description(records: Iterable[dict[str, Any]]) -> list[list[dict[str, Any]]]:
    """Split records into one collection per ``description``, in first-seen order."""
    groups: dict[str, list[dict[str, Any]]] = {}
    for record in records:
        groups.setdefault(str(record["description"]), []).append(record)
    return list(groups.values())


def point_filename(source: str, request: Any, station_id: str) -> str:
    """File name for a point request, matching :mod:`noaa_api`'s scheme."""
    def text(number: float) -> str:
        return f"{number:.4f}".replace("-", "m").replace(".", "p")

    safe_station = "".join(c if c.isalnum() else "_" for c in station_id)
    return (
        f"{request.topic}_{text(request.latitude)}_{text(request.longitude)}_{source.lower()}_"
        f"{safe_station}_{request.start_date.isoformat()}_{request.end_date.isoformat()}.json"
    )


def nearest_station(
    stations: Iterable[Station], latitude: float, longitude: float, start_date: date, end_date: date
) -> list[Station]:
    """Stations with data in the range, nearest first."""
    usable = [s for s in stations if s.coverage_of(start_date, end_date) > 0]
    return sorted(usable, key=lambda s: distance_km(latitude, longitude, s.latitude, s.longitude))


# ------------------------------------------------------------------ source base


@dataclass(frozen=True)
class SourceTopic:
    """A topic offered by an additional source.

    :param label: Human-readable name.
    :param variables: Shared ``description`` codes the source delivers for it.
    :param description: Short note about the values.
    """

    label: str
    variables: tuple[str, ...]
    description: str


class StationSource:
    """Base class of the station databases; implements the point-request protocol.

    Subclasses set :attr:`SOURCE`, :attr:`COVERAGE`, :attr:`TOPICS` and
    implement :meth:`stations` and :meth:`fetch`.
    """

    SOURCE: str = ""
    """Display name, also written into every record's ``source``."""

    PRIORITY: int = 0
    """Lower wins against a copy of the same station in another database."""

    COVERAGE: tuple[float, float, float, float] = (-180.0, -90.0, 180.0, 90.0)
    """``(west, south, east, north)`` box outside which the source has no stations."""

    TOPICS: dict[str, SourceTopic] = {}

    POINT_RADIUS_KM: float = 150.0
    """A point request only uses stations within this distance."""

    POINT_ATTEMPTS: int = 3
    """Nearest stations tried until one has values in the requested range."""

    @classmethod
    def list_topics(cls) -> list[tuple[str, SourceTopic]]:
        """Topic keys and definitions, as required by ``api_wrapper``."""
        return list(cls.TOPICS.items())

    @classmethod
    def covers(cls, latitude: float, longitude: float) -> bool:
        """Whether the source can have data at this point."""
        return in_box(latitude, longitude, cls.COVERAGE)

    @classmethod
    def covers_box(cls, bbox: tuple[float, float, float, float]) -> bool:
        """Whether the source can have stations in this box."""
        return boxes_overlap(bbox, cls.COVERAGE)

    def stations(
        self, bbox: tuple[float, float, float, float], topic: str, start_date: date, end_date: date
    ) -> list[Station]:
        """Stations in ``bbox`` that may report ``topic``; ``coverage`` filled in."""
        raise NotImplementedError

    def fetch(
        self, stations: list[Station], topic: str, start_date: date, end_date: date
    ) -> list[dict[str, Any]]:
        """Records of ``topic`` for all ``stations`` in the inclusive date range."""
        raise NotImplementedError

    def fetch_point_data(self, *, request: Any, output_dir: str | Path) -> list[Iterator[dict[str, Any]]]:
        """Nearest station with data; one iterator per variable (see ``api_wrapper``)."""
        topic = request.topic.lower()
        if topic not in self.TOPICS:
            raise ValueError(f"{self.SOURCE} has no topic {request.topic!r}.")
        if not self.covers(request.latitude, request.longitude):
            raise SourceError(f"{self.SOURCE} has no stations near this point.")
        box = point_box(request.latitude, request.longitude, self.POINT_RADIUS_KM)
        candidates = [
            station
            for station in nearest_station(
                self.stations(box, topic, request.start_date, request.end_date),
                request.latitude, request.longitude, request.start_date, request.end_date,
            )
            if distance_km(request.latitude, request.longitude, station.latitude, station.longitude)
            <= self.POINT_RADIUS_KM
        ]
        # Stations covering most of the range first, each group nearest first.
        candidates.sort(key=lambda s: s.coverage_of(request.start_date, request.end_date) < 0.8)
        if not candidates:
            raise SourceError(
                f"No {self.SOURCE} station reports {topic} within {self.POINT_RADIUS_KM:.0f} km "
                "for the selected time range."
            )
        # A station's listed period can be longer than its actual values, so
        # the next candidate is tried while the values span too little.
        best: tuple[float, Station, list[dict[str, Any]]] | None = None
        for station in candidates[: self.POINT_ATTEMPTS]:
            records = self.fetch([station], topic, request.start_date, request.end_date)
            if not records:
                continue
            days = sorted(record["date"] for record in records)
            span = (date.fromisoformat(days[-1][:10]) - date.fromisoformat(days[0][:10])).days + 1
            coverage = span / ((request.end_date - request.start_date).days + 1)
            if best is None or coverage > best[0]:
                best = (coverage, station, records)
            if coverage >= 0.8:
                break
        if best is not None:
            _, station, records = best
            path = Path(output_dir) / point_filename(self.SOURCE, request, station.id)
            return save_and_iterate(group_by_description(records), path)
        raise SourceError(
            f"The nearest {self.SOURCE} stations have no {topic} values in the selected time range."
        )
