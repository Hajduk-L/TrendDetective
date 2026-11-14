"""Satellite ice thickness from NOAA CoastWatch/PolarWatch (VIIRS on NOAA-20).

The ERDDAP server at ``polarwatch.noaa.gov`` needs no registration. The
daily ice-thickness grids (since March 2021, about 800 m cells) use polar
stereographic projections (EPSG:3413 in the north, EPSG:3976 in the south),
so a point is projected to grid metres first (:func:`polar_stereographic`).
VIIRS measures thin ice (up to a few metres) on clear-sky days only, so many
days have no value. The cells within :data:`WINDOW_M` of the point are
averaged per day.
"""

from __future__ import annotations

import math
import time
from datetime import date, timedelta
from pathlib import Path
from typing import Any, Iterator

from station_sources import (
    SourceError,
    SourceTopic,
    Station,
    StationSource,
    group_by_description,
    http_get_json,
    point_filename,
    save_and_iterate,
)

ERDDAP_URL: str = "https://polarwatch.noaa.gov/erddap/griddap"
FIRST_DAY: date = date(2021, 3, 23)
GRID_HALF_WIDTH_M: float = 3_434_002.5
WINDOW_M: float = 1_200.0
"""Cells whose centre is within this distance (per axis) of the point are averaged."""

CHUNK_DAYS: int = 92
"""Days per ERDDAP request; long requests run into the server's proxy timeout."""

RETRIES: int = 2
"""Extra attempts after a 5xx answer (the PolarWatch proxy fails now and then)."""

_GRIDS: dict[str, dict[str, Any]] = {
    "north": {"dataset": "noaacwVIIRSn20icethickNP06Daily", "lat_ts": 70.0, "lon_0": -45.0},
    "south": {"dataset": "noaacwVIIRSn20icethickSP06Daily", "lat_ts": -70.0, "lon_0": 0.0},
}

_A: float = 6_378_137.0
_E: float = math.sqrt(0.00669437999014)  # WGS 84


def polar_stereographic(latitude: float, longitude: float, lat_ts: float, lon_0: float) -> tuple[float, float]:
    """Project to polar stereographic metres (Snyder 1987, eqs. 21-33/21-34, ellipsoid).

    The southern projection is the northern one with the signs of latitudes,
    longitudes and of the result swapped.
    """
    south = lat_ts < 0
    if south:
        latitude, longitude, lat_ts, lon_0 = -latitude, -longitude, -lat_ts, -lon_0

    def t(phi: float) -> float:
        sin_phi = math.sin(phi)
        return math.tan(math.pi / 4 - phi / 2) / ((1 - _E * sin_phi) / (1 + _E * sin_phi)) ** (_E / 2)

    phi, phi_c = math.radians(latitude), math.radians(lat_ts)
    m_c = math.cos(phi_c) / math.sqrt(1 - _E**2 * math.sin(phi_c) ** 2)
    rho = _A * m_c * t(phi) / t(phi_c)
    d_lambda = math.radians(longitude - lon_0)
    x, y = rho * math.sin(d_lambda), -rho * math.cos(d_lambda)
    return (-x, -y) if south else (x, y)


def _chunks(start: date, end: date) -> list[tuple[date, date]]:
    """Split a range into pieces of :data:`CHUNK_DAYS` days (one ERDDAP request each)."""
    chunks: list[tuple[date, date]] = []
    while start <= end:
        chunk_end = min(end, start + timedelta(days=CHUNK_DAYS - 1))
        chunks.append((start, chunk_end))
        start = chunk_end + timedelta(days=1)
    return chunks


def _grid_for(latitude: float, longitude: float) -> tuple[dict[str, Any], float, float] | None:
    """The polar grid containing the point and its projected position, if any."""
    grid = _GRIDS["north" if latitude > 0 else "south"]
    x, y = polar_stereographic(latitude, longitude, grid["lat_ts"], grid["lon_0"])
    limit = GRID_HALF_WIDTH_M - WINDOW_M
    if abs(x) > limit or abs(y) > limit:
        return None
    return grid, x, y


class PolarWatchIceClient(StationSource):
    """Daily satellite (VIIRS) sea- and lake-ice thickness around a point."""

    SOURCE = "NOAA PolarWatch VIIRS"
    PRIORITY = 9
    TOPICS = {
        "ice_thickness_satellite": SourceTopic(
            "Ice thickness (VIIRS satellite)", ("viirs_ice_thickness",),
            "Daily ice thickness from VIIRS on NOAA-20 (thin ice, clear-sky days, since 2021).",
        ),
    }

    @classmethod
    def covers(cls, latitude: float, longitude: float) -> bool:
        return _grid_for(latitude, longitude) is not None

    @classmethod
    def covers_box(cls, bbox: tuple[float, float, float, float]) -> bool:
        return False  # point-only: a grid cell is not a station

    def stations(
        self, bbox: tuple[float, float, float, float], topic: str, start_date: date, end_date: date
    ) -> list[Station]:
        return []

    def fetch(
        self, stations: list[Station], topic: str, start_date: date, end_date: date
    ) -> list[dict[str, Any]]:
        records: list[dict[str, Any]] = []
        start_date = max(start_date, FIRST_DAY)
        if end_date < start_date:
            return records
        for station in stations:
            located = _grid_for(station.latitude, station.longitude)
            if located is None:
                continue
            grid, x, y = located
            by_day: dict[str, list[float]] = {}
            for chunk_start, chunk_end in _chunks(start_date, end_date):
                for row in self._rows(grid["dataset"], x, y, chunk_start, chunk_end):
                    time_text, value = row
                    if isinstance(value, (int, float)) and math.isfinite(value) and value >= 0:
                        by_day.setdefault(str(time_text)[:10], []).append(float(value))
            for day, values in sorted(by_day.items()):
                records.append(
                    station.record(day, round(sum(values) / len(values), 3), "viirs_ice_thickness", "m")
                )
        return records

    def _rows(
        self, dataset: str, x: float, y: float, start_date: date, end_date: date
    ) -> list[tuple[Any, Any]]:
        """``(time, thickness)`` of all cells in the window; retried on proxy errors."""
        query = (
            f"IceThickness[({start_date.isoformat()}T00:00:00Z):1:({end_date.isoformat()}T23:59:59Z)]"
            f"[(0.0)][({y + WINDOW_M}):1:({y - WINDOW_M})][({x - WINDOW_M}):1:({x + WINDOW_M})]"
        )
        for attempt in range(RETRIES + 1):
            try:
                payload = http_get_json(f"{ERDDAP_URL}/{dataset}.json?{query}", source=self.SOURCE)
                break
            except SourceError as error:
                message = str(error)
                if "no matching results" in message or "(404)" in message:
                    return []
                if attempt == RETRIES or not any(f"({code})" in message for code in (500, 502, 503, 504)):
                    raise
                time.sleep(2 * (attempt + 1))
        table = payload.get("table", {}) if isinstance(payload, dict) else {}
        columns = table.get("columnNames", [])
        if "time" not in columns or "IceThickness" not in columns:
            return []
        time_index, value_index = columns.index("time"), columns.index("IceThickness")
        return [(row[time_index], row[value_index]) for row in table.get("rows", [])]

    def fetch_point_data(self, *, request: Any, output_dir: str | Path) -> list[Iterator[dict[str, Any]]]:
        """Daily mean ice thickness of the cells around the point."""
        if request.topic.lower() not in self.TOPICS:
            raise ValueError(f"PolarWatch has no topic {request.topic!r}.")
        if not self.covers(request.latitude, request.longitude):
            raise SourceError("The VIIRS ice-thickness grids only cover the polar regions.")
        station = Station(
            source=self.SOURCE,
            id=f"VIIRS:{request.latitude:.3f},{request.longitude:.3f}",
            name=f"VIIRS ice grid around {request.latitude:.3f}, {request.longitude:.3f} (satellite)",
            latitude=request.latitude,
            longitude=request.longitude,
        )
        records = self.fetch([station], request.topic.lower(), request.start_date, request.end_date)
        if not records:
            raise SourceError(
                "VIIRS reports no ice thickness here in the selected time range "
                f"(data start on {FIRST_DAY.isoformat()}; open water and cloudy days have no value)."
            )
        path = Path(output_dir) / point_filename(self.SOURCE, request, station.id)
        return save_and_iterate(group_by_description(records), path)


__all__ = ["PolarWatchIceClient", "polar_stereographic"]
