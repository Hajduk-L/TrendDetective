"""Daily climate observations of Environment and Climate Change Canada (ECCC).

Uses the MSC GeoMet OGC API (``api.weather.gc.ca``), which needs no
registration: ``climate-stations`` lists stations with their daily record
period, ECCC climate id and WMO number, ``climate-daily`` holds the values.
GHCN-Daily ids of Canadian stations (``CAN0`` + climate id) contain the same
climate id, so duplicates with NOAA are matched exactly.
"""

from __future__ import annotations

from datetime import date, datetime
from typing import Any

from station_sources import (
    SourceTopic,
    Station,
    StationSource,
    http_get_json,
    with_coverage,
    wmo_key,
)

BASE_URL: str = "https://api.weather.gc.ca/collections"
PAGE_SIZE: int = 10000

_FIELDS: dict[str, tuple[str, str, float]] = {
    # GeoMet property: (shared description, unit, factor)
    "MAX_TEMPERATURE": ("tmax", "°C", 1.0),
    "MIN_TEMPERATURE": ("tmin", "°C", 1.0),
    "MEAN_TEMPERATURE": ("tavg", "°C", 1.0),
    "TOTAL_PRECIPITATION": ("prcp", "mm", 1.0),
    "TOTAL_SNOW": ("snow", "mm", 10.0),  # cm
    "SNOW_ON_GROUND": ("snwd", "mm", 10.0),  # cm
    "SPEED_MAX_GUST": ("wsfg", "m/s", 1 / 3.6),  # km/h
}


def _day(text: Any) -> date | None:
    try:
        return datetime.fromisoformat(str(text)[:10]).date()
    except ValueError:
        return None


class ECCCClient(StationSource):
    """Canadian daily climate data (temperature, precipitation, snow, gusts)."""

    SOURCE = "ECCC"
    PRIORITY = 0
    COVERAGE = (-141.5, 41.5, -52.0, 83.5)
    TOPICS = {
        "temperature": SourceTopic(
            "Daily air temperature", ("tmax", "tmin", "tavg"),
            "Daily maximum, minimum and mean air temperature.",
        ),
        "precipitation": SourceTopic("Daily precipitation", ("prcp",), "Daily total precipitation."),
        "snowfall": SourceTopic("Snowfall", ("snow",), "Daily snowfall."),
        "snow_depth": SourceTopic("Snow depth", ("snwd",), "Snow on the ground."),
        "wind_speed": SourceTopic("Daily wind speed", ("wsfg",), "Speed of the day's maximum gust."),
    }

    def stations(
        self, bbox: tuple[float, float, float, float], topic: str, start_date: date, end_date: date
    ) -> list[Station]:
        west, south, east, north = bbox
        payload = http_get_json(
            f"{BASE_URL}/climate-stations/items",
            {"bbox": f"{west},{south},{east},{north}", "limit": 2000, "f": "json"},
            source=self.SOURCE,
        )
        stations: list[Station] = []
        for feature in payload.get("features", []) if isinstance(payload, dict) else []:
            properties = feature.get("properties") or {}
            coordinates = (feature.get("geometry") or {}).get("coordinates") or []
            climate_id = properties.get("CLIMATE_IDENTIFIER")
            first, last = _day(properties.get("DLY_FIRST_DATE")), _day(properties.get("DLY_LAST_DATE"))
            if not climate_id or len(coordinates) < 2 or first is None or last is None:
                continue  # no daily data at this station
            keys = {f"eccc:{climate_id}"}
            wmo = wmo_key(properties.get("WMO_IDENTIFIER"))
            if wmo:
                keys.add(wmo)
            try:
                elevation: float | None = float(properties.get("ELEVATION"))
            except (TypeError, ValueError):
                elevation = None
            station = with_coverage(
                Station(
                    source=self.SOURCE,
                    id=f"ECCC:{climate_id}",
                    name=str(properties.get("STATION_NAME") or climate_id).title(),
                    latitude=float(coordinates[1]),
                    longitude=float(coordinates[0]),
                    elevation=elevation,
                    first_date=first,
                    last_date=last,
                    ids=frozenset(keys),
                    priority=self.PRIORITY,
                    extra={"climate_id": climate_id},
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
        fields = {name: spec for name, spec in _FIELDS.items() if spec[0] in wanted}
        records: list[dict[str, Any]] = []
        for station in stations:
            offset = 0
            while True:
                payload = http_get_json(
                    f"{BASE_URL}/climate-daily/items",
                    {
                        "CLIMATE_IDENTIFIER": station.extra["climate_id"],
                        "datetime": f"{start_date.isoformat()}/{end_date.isoformat()}",
                        "properties": ",".join(["LOCAL_DATE", *fields]),
                        "skipGeometry": "true",
                        "sortby": "LOCAL_DATE",
                        "limit": PAGE_SIZE,
                        "offset": offset,
                        "f": "json",
                    },
                    source=self.SOURCE,
                )
                features = payload.get("features", []) if isinstance(payload, dict) else []
                for feature in features:
                    properties = feature.get("properties") or {}
                    day = str(properties.get("LOCAL_DATE") or "")[:10]
                    if len(day) != 10:
                        continue
                    for name, (description, unit, factor) in fields.items():
                        value = properties.get(name)
                        if isinstance(value, (int, float)) and not isinstance(value, bool):
                            records.append(station.record(day, round(value * factor, 3), description, unit))
                if len(features) < PAGE_SIZE:
                    break
                offset += PAGE_SIZE
        return records


__all__ = ["ECCCClient"]
