"""Daily weather observations of the Finnish Meteorological Institute (FMI).

FMI's open-data WFS service needs no registration. ``fmi::ef::stations``
lists the stations with their FMISID and WMO number;
``fmi::observations::weather::daily::simple`` returns daily values. One
request may span at most 8928 hours, so ranges are split into years.
"""

from __future__ import annotations

import math
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta
from typing import Any

from station_sources import (
    SourceTopic,
    Station,
    StationSource,
    http_get,
    in_box,
    with_coverage,
    wmo_key,
)

WFS_URL: str = "https://opendata.fmi.fi/wfs"
STATIONS_PER_REQUEST: int = 10
PARALLEL_REQUESTS: int = 3
MAX_DAYS_PER_REQUEST: int = 365

_NS = {
    "wfs": "http://www.opengis.net/wfs/2.0",
    "gml": "http://www.opengis.net/gml/3.2",
    "ef": "http://inspire.ec.europa.eu/schemas/ef/4.0",
    "xlink": "http://www.w3.org/1999/xlink",
    "BsWfs": "http://xml.fmi.fi/schema/wfs/2.0",
}

_PARAMETERS: dict[str, tuple[str, str, float]] = {
    # FMI parameter: (shared description, unit, factor)
    "tmax": ("tmax", "°C", 1.0),
    "tmin": ("tmin", "°C", 1.0),
    "tday": ("tavg", "°C", 1.0),
    "rrday": ("prcp", "mm", 1.0),
    "snow": ("snwd", "mm", 10.0),  # cm
}
_NONE_REPORTED: frozenset[str] = frozenset({"rrday", "snow"})
"""FMI writes -1 for "no precipitation" / "no snow"; these become 0."""

_WEATHER_NETWORK_WORDS: tuple[str, ...] = ("sääasema", "lentosääasema", "sademäärä")
"""Station networks (Finnish titles) that measure weather, not air quality or tides."""


def _year_chunks(start: date, end: date) -> list[tuple[date, date]]:
    chunks: list[tuple[date, date]] = []
    chunk_start = start
    while chunk_start <= end:
        chunk_end = min(end, chunk_start + timedelta(days=MAX_DAYS_PER_REQUEST - 1))
        chunks.append((chunk_start, chunk_end))
        chunk_start = chunk_end + timedelta(days=1)
    return chunks


def _parse_stations(xml: bytes) -> list[dict[str, Any]]:
    root = ET.fromstring(xml)
    rows: list[dict[str, Any]] = []
    for facility in root.iter(f"{{{_NS['ef']}}}EnvironmentalMonitoringFacility"):
        fmisid = facility.findtext("gml:identifier", default="", namespaces=_NS).strip()
        names = {
            element.get("codeSpace", "").rsplit("/", 1)[-1]: (element.text or "").strip()
            for element in facility.findall("gml:name", _NS)
        }
        networks = " ".join(
            (element.get(f"{{{_NS['xlink']}}}title") or "").lower()
            for element in facility.findall("ef:belongsTo", _NS)
        )
        position = facility.findtext(".//ef:representativePoint//gml:pos", default="", namespaces=_NS).split()
        begin = facility.findtext(".//gml:beginPosition", default="", namespaces=_NS).strip()
        if not fmisid or len(position) < 2 or not any(word in networks for word in _WEATHER_NETWORK_WORDS):
            continue
        try:
            first = datetime.fromisoformat(begin[:10]).date() if begin else None
        except ValueError:
            first = None
        rows.append(
            {
                "fmisid": fmisid,
                "name": names.get("name") or fmisid,
                "wmo": names.get("wmo"),
                "latitude": float(position[0]),
                "longitude": float(position[1]),
                "first": first,
            }
        )
    return rows


def _parse_observations(xml: bytes) -> list[tuple[float, float, str, str, float]]:
    """``(latitude, longitude, day, parameter, value)`` of a ``…::simple`` response."""
    root = ET.fromstring(xml)
    values: list[tuple[float, float, str, str, float]] = []
    for element in root.iter(f"{{{_NS['BsWfs']}}}BsWfsElement"):
        position = element.findtext(".//gml:pos", default="", namespaces=_NS).split()
        day = element.findtext("BsWfs:Time", default="", namespaces=_NS)[:10]
        name = element.findtext("BsWfs:ParameterName", default="", namespaces=_NS)
        text = element.findtext("BsWfs:ParameterValue", default="", namespaces=_NS)
        try:
            value = float(text)
        except ValueError:
            continue
        if len(position) < 2 or not math.isfinite(value):
            continue
        values.append((float(position[0]), float(position[1]), day, name, value))
    return values


class FMIClient(StationSource):
    """Finnish daily weather observations (temperature, precipitation, snow depth)."""

    SOURCE = "FMI"
    PRIORITY = 0
    COVERAGE = (19.0, 59.4, 31.7, 70.2)
    TOPICS = {
        "temperature": SourceTopic(
            "Daily air temperature", ("tmax", "tmin", "tavg"),
            "Daily maximum, minimum and mean air temperature.",
        ),
        "precipitation": SourceTopic("Daily precipitation", ("prcp",), "Daily precipitation total."),
        "snow_depth": SourceTopic("Snow depth", ("snwd",), "Snow depth."),
    }

    _station_rows: list[dict[str, Any]] | None = None

    @classmethod
    def _all_stations(cls) -> list[dict[str, Any]]:
        if cls._station_rows is None:
            xml = http_get(
                WFS_URL,
                {"service": "WFS", "version": "2.0.0", "request": "getFeature",
                 "storedquery_id": "fmi::ef::stations"},
                source="FMI",
            )
            cls._station_rows = _parse_stations(xml)
        return cls._station_rows

    def stations(
        self, bbox: tuple[float, float, float, float], topic: str, start_date: date, end_date: date
    ) -> list[Station]:
        stations: list[Station] = []
        for row in self._all_stations():
            if not in_box(row["latitude"], row["longitude"], bbox):
                continue
            keys = {f"fmi:{row['fmisid']}"}
            wmo = wmo_key(row["wmo"])
            if wmo:
                keys.add(wmo)
            station = with_coverage(
                Station(
                    source=self.SOURCE,
                    id=f"FMI:{row['fmisid']}",
                    name=row["name"],
                    latitude=row["latitude"],
                    longitude=row["longitude"],
                    first_date=row["first"],
                    last_date=date.today() if row["first"] else None,
                    ids=frozenset(keys),
                    priority=self.PRIORITY,
                    extra={"fmisid": row["fmisid"]},
                ),
                start_date, end_date,
            )
            if station.coverage > 0:
                stations.append(station)
        return stations

    def fetch(
        self, stations: list[Station], topic: str, start_date: date, end_date: date
    ) -> list[dict[str, Any]]:
        wanted = set(self.TOPICS[topic].variables)
        parameters = {name: spec for name, spec in _PARAMETERS.items() if spec[0] in wanted}
        jobs = [
            (stations[offset : offset + STATIONS_PER_REQUEST], chunk)
            for offset in range(0, len(stations), STATIONS_PER_REQUEST)
            for chunk in _year_chunks(start_date, end_date)
        ]

        def run(job: tuple[list[Station], tuple[date, date]]) -> list[dict[str, Any]]:
            group, (chunk_start, chunk_end) = job
            params: list[tuple[str, Any]] = [
                ("service", "WFS"), ("version", "2.0.0"), ("request", "getFeature"),
                ("storedquery_id", "fmi::observations::weather::daily::simple"),
                ("starttime", f"{chunk_start.isoformat()}T00:00:00Z"),
                ("endtime", f"{chunk_end.isoformat()}T00:00:00Z"),
                ("parameters", ",".join(parameters)),
            ]
            params += [("fmisid", station.extra["fmisid"]) for station in group]
            rows = _parse_observations(http_get(WFS_URL, params, source=self.SOURCE))
            out: list[dict[str, Any]] = []
            for latitude, longitude, day, name, value in rows:
                # The simple format names no station; its position identifies it.
                station = min(
                    group, key=lambda s: abs(s.latitude - latitude) + abs(s.longitude - longitude)
                )
                if abs(station.latitude - latitude) + abs(station.longitude - longitude) > 0.01:
                    continue
                spec = parameters.get(name)
                if spec is None:
                    continue
                description, unit, factor = spec
                if name in _NONE_REPORTED and value < 0:
                    value = 0.0
                out.append(station.record(day, round(value * factor, 3), description, unit))
            return out

        records: list[dict[str, Any]] = []
        with ThreadPoolExecutor(max_workers=PARALLEL_REQUESTS) as pool:
            for part in pool.map(run, jobs):
                records.extend(part)
        return records


__all__ = ["FMIClient"]
