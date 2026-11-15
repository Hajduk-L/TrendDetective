"""Daily observations of the German weather service (DWD), from its Open Data server.

No registration is needed. Data come from the Climate Data Center (CDC)
directory ``observations_germany/climate/daily``, from two station networks
(:data:`PRODUCTS`):

* ``kl`` – about 1,100 climate stations: temperature and wind;
* ``more_precip`` – about 6,600 precipitation stations (including the climate
  stations): precipitation, snow depth and fresh snow.

Every station has one zip with its whole history up to last year
(``historical/``) and one with the last ~500 days (``recent/``). Both are
cached in :data:`station_sources.CACHE_DIR`.

DWD numbers its stations itself (``00403``). WMO numbers, needed to recognise
the same station in GHCN-Daily, come from the Bright Sky API, which mirrors
DWD's data; if it is unreachable, duplicates are still found by position.
"""

from __future__ import annotations

import csv
import io
import re
import threading
import zipfile
from dataclasses import dataclass
from datetime import date, datetime
from pathlib import Path
from typing import Any

from station_sources import (
    CACHE_DIR,
    SourceError,
    SourceTopic,
    Station,
    StationSource,
    cached_download,
    distance_km,
    http_get,
    http_get_json,
    in_box,
    with_coverage,
    wmo_key,
)

BASE_URL: str = "https://opendata.dwd.de/climate_environment/CDC/observations_germany/climate/daily/"
BRIGHT_SKY_SOURCES_URL: str = "https://api.brightsky.dev/sources"

_MISSING: float = -999.0


@dataclass(frozen=True)
class Product:
    """One DWD daily product: its directory, file prefix and columns.

    ``columns`` maps a DWD column to ``(shared description, unit, factor)``.
    """

    directory: str
    prefix: str
    columns: dict[str, tuple[str, str, float]]

    @property
    def url(self) -> str:
        return f"{BASE_URL}{self.directory}/"

    @property
    def station_list(self) -> str:
        return f"{self.url}historical/{self.prefix}_Tageswerte_Beschreibung_Stationen.txt"


PRODUCTS: dict[str, Product] = {
    "kl": Product(
        "kl", "KL",
        {
            "TXK": ("tmax", "°C", 1.0),
            "TNK": ("tmin", "°C", 1.0),
            "TMK": ("tavg", "°C", 1.0),
            "FM": ("awnd", "m/s", 1.0),
            "FX": ("wsfg", "m/s", 1.0),
        },
    ),
    "more_precip": Product(
        "more_precip", "RR",
        {
            "RS": ("prcp", "mm", 1.0),
            "SH_TAG": ("snwd", "mm", 10.0),  # cm
            "NSH_TAG": ("snow", "mm", 10.0),  # cm of fresh snow
        },
    ),
}

_TOPIC_PRODUCTS: dict[str, str] = {
    "temperature": "kl",
    "wind_speed": "kl",
    "precipitation": "more_precip",
    "snow_depth": "more_precip",
    "snowfall": "more_precip",
}


def _parse_station_list(text: str) -> list[dict[str, Any]]:
    """Rows of a fixed-width ``*_Tageswerte_Beschreibung_Stationen.txt``."""
    pattern = re.compile(
        r"^(\d{5})\s+(\d{8})\s+(\d{8})\s+(-?\d+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(.+?)(?:\s{2,}|$)"
    )
    rows: list[dict[str, Any]] = []
    for line in text.splitlines():
        match = pattern.match(line)
        if not match:
            continue
        rows.append(
            {
                "id": match.group(1),
                "first": datetime.strptime(match.group(2), "%Y%m%d").date(),
                "last": datetime.strptime(match.group(3), "%Y%m%d").date(),
                "elevation": float(match.group(4)),
                "latitude": float(match.group(5)),
                "longitude": float(match.group(6)),
                "name": match.group(7).strip(),
            }
        )
    return rows


def _parse_product(text: str) -> list[dict[str, str]]:
    """Rows of a ``produkt_*.txt`` file, keys and values stripped."""
    reader = csv.reader(io.StringIO(text), delimiter=";")
    header = [name.strip() for name in next(reader, [])]
    return [
        {name: value.strip() for name, value in zip(header, row)}
        for row in reader
        if len(row) >= len(header) - 1
    ]


class DWDClient(StationSource):
    """German weather service daily data (temperature, precipitation, snow, wind)."""

    SOURCE = "DWD"
    PRIORITY = 0
    COVERAGE = (5.5, 47.0, 15.5, 55.2)
    TOPICS = {
        "temperature": SourceTopic(
            "Daily air temperature", ("tmax", "tmin", "tavg"),
            "Daily maximum, minimum and mean air temperature (2 m).",
        ),
        "precipitation": SourceTopic("Daily precipitation", ("prcp",), "Daily precipitation total."),
        "snowfall": SourceTopic("Snowfall", ("snow",), "Depth of fresh snow."),
        "snow_depth": SourceTopic("Snow depth", ("snwd",), "Snow depth in the morning."),
        "wind_speed": SourceTopic(
            "Daily wind speed", ("awnd", "wsfg"), "Daily mean wind speed and peak gust."
        ),
    }

    _station_rows: dict[str, list[dict[str, Any]]] = {}
    _historical_files: dict[str, dict[str, str]] = {}
    _wmo_numbers: dict[str, str] = {}
    _wmo_boxes: list[tuple[float, float, float, float]] = []
    # Guards the class-level caches above: parallel requests fill each one once.
    _cache_lock = threading.RLock()

    # ------------------------------------------------------------ stations

    @classmethod
    def _all_stations(cls, product: Product) -> list[dict[str, Any]]:
        with cls._cache_lock:
            if product.directory not in cls._station_rows:
                path = cached_download(
                    product.station_list, CACHE_DIR / "dwd" / f"{product.prefix}_stations.txt",
                    source="DWD", max_age_days=1.0,
                )
                cls._station_rows[product.directory] = _parse_station_list(path.read_text(encoding="latin-1"))
            return cls._station_rows[product.directory]

    @classmethod
    def _load_wmo_numbers(cls, bbox: tuple[float, float, float, float]) -> None:
        """Fill :attr:`_wmo_numbers` (DWD id → WMO number) around ``bbox`` from Bright Sky."""
        with cls._cache_lock:
            if any(all(a <= b if i < 2 else a >= b for i, (a, b) in enumerate(zip(box, bbox)))
                   for box in cls._wmo_boxes):
                return  # already asked for a box containing this one
            west, south, east, north = bbox
            latitude, longitude = (south + north) / 2, (west + east) / 2
            radius_m = min(500_000, int(distance_km(latitude, longitude, north, east) * 1000) + 10_000)
            try:
                payload = http_get_json(
                    BRIGHT_SKY_SOURCES_URL,
                    {"lat": latitude, "lon": longitude, "max_dist": radius_m},
                    source="Bright Sky", timeout=20, max_seconds=40,
                )
            except SourceError:
                return  # co-location still finds most duplicates
            cls._wmo_boxes.append(bbox)
            for source in payload.get("sources", []) if isinstance(payload, dict) else []:
                dwd_id, wmo = source.get("dwd_station_id"), source.get("wmo_station_id")
                if dwd_id and wmo and str(wmo).isdigit():
                    cls._wmo_numbers.setdefault(str(dwd_id), str(wmo))

    def stations(
        self, bbox: tuple[float, float, float, float], topic: str, start_date: date, end_date: date
    ) -> list[Station]:
        product = PRODUCTS[_TOPIC_PRODUCTS[topic]]
        rows = [row for row in self._all_stations(product) if in_box(row["latitude"], row["longitude"], bbox)]
        if not rows:
            return []
        self._load_wmo_numbers(bbox)
        stations: list[Station] = []
        for row in rows:
            keys = {f"dwd:{row['id']}"}
            wmo = wmo_key(self._wmo_numbers.get(row["id"]))
            if wmo:
                keys.add(wmo)
            station = with_coverage(
                Station(
                    source=self.SOURCE,
                    id=f"DWD:{row['id']}",
                    name=row["name"],
                    latitude=row["latitude"],
                    longitude=row["longitude"],
                    elevation=row["elevation"],
                    first_date=row["first"],
                    last_date=row["last"],
                    ids=frozenset(keys),
                    priority=self.PRIORITY,
                    extra={"dwd_id": row["id"]},
                ),
                start_date, end_date,
            )
            if station.coverage > 0:
                stations.append(station)
        return stations

    # ---------------------------------------------------------------- data

    @classmethod
    def _historical_file_names(cls, product: Product) -> dict[str, str]:
        """DWD id → file name in ``historical/`` (the name holds the record's dates)."""
        with cls._cache_lock:
            if product.directory not in cls._historical_files:
                listing = http_get(product.url + "historical/", source="DWD").decode("latin-1")
                cls._historical_files[product.directory] = {
                    match.group(1): match.group(0)
                    for match in re.finditer(
                        rf"tageswerte_{product.prefix}_(\d{{5}})_\d{{8}}_\d{{8}}_hist\.zip", listing
                    )
                }
            return cls._historical_files[product.directory]

    @staticmethod
    def _zip_rows(url: str, path: Path, max_age_days: float) -> list[dict[str, str]]:
        try:
            cached_download(url, path, source="DWD", max_age_days=max_age_days)
        except SourceError as error:
            if "(404)" in str(error):
                return []
            raise
        try:
            with zipfile.ZipFile(path) as archive:
                name = next((n for n in archive.namelist() if n.startswith("produkt_")), None)
                return _parse_product(archive.read(name).decode("latin-1")) if name else []
        except zipfile.BadZipFile:
            path.unlink(missing_ok=True)
            return []

    def _station_rows_for(
        self, product: Product, dwd_id: str, start_date: date, end_date: date
    ) -> list[dict[str, str]]:
        rows: list[dict[str, str]] = []
        historical = self._historical_file_names(product).get(dwd_id)
        if historical and start_date.year <= int(historical.split("_")[4][:4]):
            rows += self._zip_rows(
                f"{product.url}historical/{historical}", CACHE_DIR / "dwd" / historical, max_age_days=30.0
            )
        if end_date >= date(date.today().year - 2, 1, 1):
            name = f"tageswerte_{product.prefix}_{dwd_id}_akt.zip"
            rows += self._zip_rows(f"{product.url}recent/{name}", CACHE_DIR / "dwd" / name, max_age_days=1.0)
        return rows

    def fetch(
        self, stations: list[Station], topic: str, start_date: date, end_date: date
    ) -> list[dict[str, Any]]:
        product = PRODUCTS[_TOPIC_PRODUCTS[topic]]
        wanted = set(self.TOPICS[topic].variables)
        columns = {column: spec for column, spec in product.columns.items() if spec[0] in wanted}
        start_text, end_text = start_date.strftime("%Y%m%d"), end_date.strftime("%Y%m%d")
        records: list[dict[str, Any]] = []
        for station in stations:
            seen_days: set[str] = set()
            for row in self._station_rows_for(product, station.extra["dwd_id"], start_date, end_date):
                day = row.get("MESS_DATUM", "")
                if not (start_text <= day <= end_text) or day in seen_days:
                    continue  # historical and recent overlap by a few months
                seen_days.add(day)
                iso_day = f"{day[:4]}-{day[4:6]}-{day[6:8]}"
                for column, (description, unit, factor) in columns.items():
                    try:
                        value = float(row.get(column, ""))
                    except ValueError:
                        continue
                    if value == _MISSING:
                        continue
                    records.append(station.record(iso_day, round(value * factor, 3), description, unit))
        return records


__all__ = ["DWDClient", "PRODUCTS"]
