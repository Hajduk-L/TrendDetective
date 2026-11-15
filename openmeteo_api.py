"""ERA5 reanalysis through the Open-Meteo Historical Weather API.

No registration or key is needed (free for non-commercial use, data under
CC BY 4.0). ERA5 is a weather *model* re-run with past observations, not a
measurement: it has a value for every place and day since 1940, so its topics
carry the suffix ``_era5`` and are never mixed into the station series.

For an area, the region is sampled at :data:`GRID_POINTS` × :data:`GRID_POINTS`
points; each point is treated like a station.
"""

from __future__ import annotations

from datetime import date
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

ARCHIVE_URL: str = "https://archive-api.open-meteo.com/v1/archive"
FIRST_DAY: date = date(1940, 1, 1)
GRID_POINTS: int = 3
LOCATIONS_PER_REQUEST: int = 10

_VARIABLES: dict[str, tuple[str, str, float]] = {
    # Open-Meteo daily variable: (shared description, unit, factor)
    "temperature_2m_max": ("tmax", "°C", 1.0),
    "temperature_2m_min": ("tmin", "°C", 1.0),
    "temperature_2m_mean": ("tavg", "°C", 1.0),
    "precipitation_sum": ("prcp", "mm", 1.0),
    "snowfall_sum": ("snow", "mm", 10.0),  # cm
    "snow_depth_max": ("snwd", "mm", 1000.0),  # m
    "wind_speed_10m_mean": ("awnd", "m/s", 1.0),
    "wind_gusts_10m_max": ("wsfg", "m/s", 1.0),
    "relative_humidity_2m_mean": ("rhav", "%", 1.0),
    "relative_humidity_2m_max": ("rhmx", "%", 1.0),
    "relative_humidity_2m_min": ("rhmn", "%", 1.0),
    "dew_point_2m_mean": ("dewp", "°C", 1.0),
    "pressure_msl_mean": ("pmsl", "hPa", 1.0),
    "cloud_cover_mean": ("cldc", "%", 1.0),
    "sunshine_duration": ("tsun", "h", 1 / 3600),  # s
    "shortwave_radiation_sum": ("srad", "MJ/m²", 1.0),
    "et0_fao_evapotranspiration": ("et0", "mm", 1.0),
    "soil_moisture_0_to_7cm_mean": ("soilm", "m³/m³", 1.0),
    "soil_temperature_0_to_7cm_mean": ("soilt", "°C", 1.0),
}

SOURCE_NAME: str = "Open-Meteo ERA5"


class OpenMeteoClient(StationSource):
    """ERA5 reanalysis values at any point (model data, labelled as such)."""

    SOURCE = SOURCE_NAME
    PRIORITY = 9
    TOPICS = {
        "temperature_era5": SourceTopic(
            "Daily air temperature (ERA5 model)", ("tmax", "tmin", "tavg"),
            "ERA5 reanalysis: daily maximum, minimum and mean 2 m temperature at the exact point.",
        ),
        "precipitation_era5": SourceTopic(
            "Daily precipitation (ERA5 model)", ("prcp",), "ERA5 reanalysis: daily precipitation sum.",
        ),
        "snowfall_era5": SourceTopic(
            "Snowfall (ERA5 model)", ("snow",), "ERA5 reanalysis: daily snowfall sum.",
        ),
        "snow_depth_era5": SourceTopic(
            "Snow depth (ERA5 model)", ("snwd",), "ERA5 reanalysis: daily maximum snow depth.",
        ),
        "wind_speed_era5": SourceTopic(
            "Daily wind speed (ERA5 model)", ("awnd", "wsfg"),
            "ERA5 reanalysis: daily mean 10 m wind speed and maximum gust.",
        ),
        "humidity_era5": SourceTopic(
            "Relative humidity (ERA5 model)", ("rhav", "rhmx", "rhmn"),
            "ERA5 reanalysis: daily mean, maximum and minimum 2 m relative humidity.",
        ),
        "dew_point_era5": SourceTopic(
            "Dew point (ERA5 model)", ("dewp",), "ERA5 reanalysis: daily mean 2 m dew point.",
        ),
        "pressure_era5": SourceTopic(
            "Sea-level pressure (ERA5 model)", ("pmsl",), "ERA5 reanalysis: daily mean pressure at sea level.",
        ),
        "cloud_cover_era5": SourceTopic(
            "Cloud cover (ERA5 model)", ("cldc",), "ERA5 reanalysis: daily mean total cloud cover.",
        ),
        "sunshine_era5": SourceTopic(
            "Sunshine duration (ERA5 model)", ("tsun",), "ERA5 reanalysis: hours of sunshine per day.",
        ),
        "solar_radiation_era5": SourceTopic(
            "Solar radiation (ERA5 model)", ("srad",), "ERA5 reanalysis: daily sum of shortwave radiation.",
        ),
        "evapotranspiration_era5": SourceTopic(
            "Evapotranspiration (ERA5 model)", ("et0",),
            "ERA5 reanalysis: FAO-56 reference evapotranspiration, a measure of drought stress.",
        ),
        "soil_moisture_era5": SourceTopic(
            "Soil moisture 0–7 cm (ERA5 model)", ("soilm",), "ERA5 reanalysis: daily mean volumetric soil water.",
        ),
        "soil_temperature_era5": SourceTopic(
            "Soil temperature 0–7 cm (ERA5 model)", ("soilt",), "ERA5 reanalysis: daily mean soil temperature.",
        ),
    }

    @staticmethod
    def _grid_station(latitude: float, longitude: float) -> Station:
        return Station(
            source=SOURCE_NAME,
            id=f"ERA5:{latitude:.2f},{longitude:.2f}",
            name=f"ERA5 grid cell at {latitude:.2f}, {longitude:.2f} (model)",
            latitude=latitude,
            longitude=longitude,
            first_date=FIRST_DAY,
            ids=frozenset({f"era5:{latitude:.2f},{longitude:.2f}"}),
            priority=OpenMeteoClient.PRIORITY,
        )

    def stations(
        self, bbox: tuple[float, float, float, float], topic: str, start_date: date, end_date: date
    ) -> list[Station]:
        west, south, east, north = bbox
        steps = [(index + 0.5) / GRID_POINTS for index in range(GRID_POINTS)]
        return [
            self._grid_station(round(south + (north - south) * fy, 4), round(west + (east - west) * fx, 4))
            for fy in steps
            for fx in steps
        ]

    def fetch(
        self, stations: list[Station], topic: str, start_date: date, end_date: date
    ) -> list[dict[str, Any]]:
        if end_date < FIRST_DAY:
            return []
        start_date = max(start_date, FIRST_DAY)
        wanted = set(self.TOPICS[topic].variables)
        variables = {name: spec for name, spec in _VARIABLES.items() if spec[0] in wanted}
        records: list[dict[str, Any]] = []
        for offset in range(0, len(stations), LOCATIONS_PER_REQUEST):
            group = stations[offset : offset + LOCATIONS_PER_REQUEST]
            payload = http_get_json(
                ARCHIVE_URL,
                {
                    "latitude": ",".join(f"{s.latitude:.4f}" for s in group),
                    "longitude": ",".join(f"{s.longitude:.4f}" for s in group),
                    "start_date": start_date.isoformat(),
                    "end_date": end_date.isoformat(),
                    "daily": ",".join(variables),
                    "wind_speed_unit": "ms",
                    "timezone": "GMT",
                    # Pure ERA5; the default blend mixes in other models for recent days.
                    "models": "era5",
                },
                source=self.SOURCE,
            )
            if isinstance(payload, dict) and payload.get("error"):
                raise SourceError(f"Open-Meteo: {payload.get('reason')}")
            answers = payload if isinstance(payload, list) else [payload]
            for station, answer in zip(group, answers):
                daily = answer.get("daily") or {}
                days = daily.get("time") or []
                for name, (description, unit, factor) in variables.items():
                    for day, value in zip(days, daily.get(name) or []):
                        if isinstance(value, (int, float)):
                            records.append(station.record(day, round(value * factor, 3), description, unit))
        return records

    def fetch_point_data(self, *, request: Any, output_dir: str | Path) -> list[Iterator[dict[str, Any]]]:
        """Values of the grid cell containing the point (no station search)."""
        topic = request.topic.lower()
        if topic not in self.TOPICS:
            raise ValueError(f"Open-Meteo has no topic {request.topic!r}.")
        station = self._grid_station(request.latitude, request.longitude)
        records = self.fetch([station], topic, request.start_date, request.end_date)
        if not records:
            raise SourceError("ERA5 has no values for this point and time range.")
        path = Path(output_dir) / point_filename(self.SOURCE, request, station.id)
        return save_and_iterate(group_by_description(records), path)


__all__ = ["OpenMeteoClient"]
