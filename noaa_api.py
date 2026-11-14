"""NOAA NCEI Access Data Service client and topic catalog.

This module uses NCEI's unauthenticated Access Data Service at
``/access/services/data/v1``. It discovers matching stations through the
Search Service using a rectangular bounding box centered on the requested
coordinate, then downloads observations from the closest matching station.
The API returns station observations; it does not interpolate an exact-point
value.

``TOPICS`` is a curated index of common climate and weather variables. Each
entry documents the dataset slug and the dataset-specific ``dataTypes`` codes
to request. NOAA has many more datasets and observation types than can be
enumerated meaningfully in one static list; the catalog can be expanded from
NCEI's live dataset metadata as the application needs additional domains.
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any, Iterator

import requests

try:
    import ijson
except ImportError:
    ijson = None  # type: ignore[assignment]

if TYPE_CHECKING:
    from api_wrapper import PointDataRequest


BASE_URL: str = "https://www.ncei.noaa.gov/access/services/data/v1"
"""NOAA NCEI Access Data Service endpoint."""

SEARCH_URL: str = "https://www.ncei.noaa.gov/access/services/search/v1/data"
"""NOAA NCEI Access Search endpoint used to discover matching stations."""

SEARCH_RADIUS_DEGREES: float = 0.05
"""Half-width of the latitude/longitude bounding box around the point.

The resulting query area is approximately 11 km north-south by 11 km east-west
at the equator; longitude width narrows toward the poles.
"""


_STANDARD_FIELDS: dict[str, str] = {
    "date": "date",
    "station": "station",
    "longitude": "longitude",
    "elevation": "elevation",
    "latitude": "latitude",
    "name": "name",
}
"""Standard NOAA station metadata mapped to normalized output names."""


def _as_number(value: Any) -> float | int | str | None:
    """Convert numeric NOAA values to numbers and preserve other values.

    :param value: Original value from an NCEI JSON field.
    :type value: typing.Any
    :returns: Integer/float for numeric input, the original string for
        non-numeric text, or ``None`` if empty.
    :rtype: float, int, str, or None
    """
    if value is None or value == "":
        return None
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, (int, float)):
        return value
    if isinstance(value, str):
        try:
            number: float = float(value)
        except ValueError:
            return value
        return int(number) if number.is_integer() else number
    return str(value)


def _normalize_observations(payload: Any) -> list[list[dict[str, Any]]]:
    """Group observations into one record collection per measured variable.

    The result is a list of collections, one for each measured variable. Every
    record contains the six normalized station metadata fields, plus a numeric
    ``value`` when NOAA provides one and lowercase variable ``description``.
    Empty measurements are omitted; non-numeric text is preserved as text.

    :param payload: JSON-decoded NCEI response, normally a list of row dicts.
    :type payload: typing.Any
    :returns: One list of observation records per measured variable.
    :rtype: list[list[dict[str, typing.Any]]]
    :raises NOAAError: If the response is not a list of object rows.
    """
    if not isinstance(payload, list) or any(
        not isinstance(row, dict) for row in payload
    ):
        raise NOAAError("NOAA NCEI returned an unexpected observation format")

    collections_by_description: dict[str, list[dict[str, Any]]] = {}
    for row in payload:
        values_by_lowercase_name: dict[str, Any] = {
            str(key).lower(): value for key, value in row.items()
        }
        metadata: dict[str, Any] = {
            output_name: values_by_lowercase_name.get(source_name)
            for source_name, output_name in _STANDARD_FIELDS.items()
        }
        for coordinate_key in ("longitude", "elevation", "latitude"):
            metadata[coordinate_key] = _as_number(metadata[coordinate_key])

        for key, raw_value in row.items():
            description: str = str(key).lower()
            if description in _STANDARD_FIELDS:
                continue
            value: float | int | str | None = _as_number(raw_value)
            if value is not None:
                collections_by_description.setdefault(description, []).append(
                    {**metadata, "value": value, "description": description}
                )

    return list(collections_by_description.values())


@dataclass(frozen=True)
class NOAATopic:
    """A user-facing variable family mapped to NCEI dataset observation codes.

    :param label: Human-readable description of the topic.
    :type label: str
    :param dataset: Exact NCEI Access Data Service dataset slug.
    :type dataset: str
    :param data_types: Exact, case-sensitive NCEI variable codes for the
        selected dataset.
    :type data_types: tuple[str, ...]
    :param description: Short note about the values returned for this topic.
    :type description: str
    """

    label: str
    dataset: str
    data_types: tuple[str, ...]
    description: str


TOPICS: dict[str, NOAATopic] = {
    # Daily station observations (Global Historical Climatology Network Daily).
    "temperature": NOAATopic(
        "Daily air temperature", "daily-summaries", ("TMAX", "TMIN", "TAVG"),
        "Daily maximum, minimum, and average air temperature.",
    ),
    "temperature_observation": NOAATopic(
        "Temperature at observation time", "daily-summaries", ("TOBS",),
        "Temperature recorded at the station's observation time.",
    ),
    "precipitation": NOAATopic(
        "Daily precipitation", "daily-summaries", ("PRCP", "MDPR", "DAPR"),
        "Daily precipitation and multiday precipitation totals.",
    ),
    "snowfall": NOAATopic(
        "Snowfall", "daily-summaries", ("SNOW", "MDSF"),
        "Daily snowfall and multiday snowfall totals.",
    ),
    "snow_depth": NOAATopic(
        "Snow depth", "daily-summaries", ("SNWD",),
        "Snow depth measured at the station.",
    ),
    "wind_speed": NOAATopic(
        "Daily wind speed", "daily-summaries", ("AWND", "WSF1", "WSF2", "WSF5", "WSFG", "WSFI", "WSFM"),
        "Average wind speed and fastest 2-minute/5-minute wind speeds where reported.",
    ),
    "wind_direction": NOAATopic(
        "Daily wind direction", "daily-summaries", ("AWDR", "WDF1", "WDF2", "WDF5", "WDFG", "WDFI", "WDFM"),
        "Direction associated with fastest 2-minute/5-minute wind speeds.",
    ),
    "humidity": NOAATopic(
        "Daily relative humidity", "daily-summaries", ("RHAV", "RHMN", "RHMX"),
        "Average, minimum, and maximum relative humidity where reported.",
    ),
    "dew_point_daily": NOAATopic(
        "Daily dew point", "daily-summaries", ("ADPT",),
        "Average daily dew-point temperature where reported.",
    ),
    "pressure_daily": NOAATopic(
        "Daily pressure", "daily-summaries", ("ASLP", "ASTP"),
        "Average sea-level and station pressure where reported.",
    ),
    "cloud_cover_daily": NOAATopic(
        "Daily cloud cover", "daily-summaries", ("ACMC", "ACMH", "ACSC", "ACSH"),
        "Average cloudiness for midnight-to-midnight and sunrise-to-sunset periods.",
    ),
    "wet_bulb_temperature": NOAATopic(
        "Daily wet-bulb temperature", "daily-summaries", ("AWBT",),
        "Average daily wet-bulb temperature where reported.",
    ),
    "sunshine": NOAATopic(
        "Percent possible sunshine", "daily-summaries", ("PSUN",),
        "Daily percent of possible sunshine.",
    ),
    "soil_temperature": NOAATopic(
        "Soil temperature", "daily-summaries",
        ("SN01", "SN02", "SN03", "SN11", "SN12", "SN13", "SN14", "SN21", "SN22", "SN23", "SN31", "SN32", "SN33", "SN34", "SN35", "SN36", "SN51", "SX23", "SX31", "SX32", "SX33", "SX34", "SX35", "SX36", "SX51", "SX52", "SX53", "SX54", "SX55", "SX56", "SX57", "SX61", "SX72", "SX81", "SX82", "SX83"),
        "Maximum and minimum soil temperature codes for available depths and ground covers.",
    ),
    "evaporation": NOAATopic(
        "Evaporation", "daily-summaries", ("EVAP",),
        "Daily evaporation where observed.",
    ),
    "water_temperature": NOAATopic(
        "Evaporation pan water temperature", "daily-summaries", ("MNPN", "MXPN"),
        "Daily minimum and maximum evaporation-pan water temperature.",
    ),
    "ice_thickness": NOAATopic(
        "Ice thickness", "daily-summaries", ("THIC",),
        "Thickness of ice on water where reported.",
    ),
    "weather_events": NOAATopic(
        "Daily weather phenomena", "daily-summaries",
        tuple(f"WT{code:02d}" for code in (*range(1, 20), 21, 22)),
        "Occurrence flags for fog, thunder, hail, precipitation, smoke, blowing snow, tornadoes, and other phenomena.",
    ),
    # Hourly Integrated Surface Database observations.
    "temperature_hourly": NOAATopic(
        "Hourly air temperature", "global-hourly", ("TMP",),
        "Dry-bulb air temperature from hourly surface reports.",
    ),
    "dew_point": NOAATopic(
        "Hourly dew point", "global-hourly", ("DEW",),
        "Dew-point temperature from hourly surface reports.",
    ),
    "relative_humidity_hourly": NOAATopic(
        "Hourly relative humidity", "global-hourly", ("RH1",),
        "Relative humidity when available in the hourly report.",
    ),
    "precipitation_hourly": NOAATopic(
        "Hourly precipitation", "global-hourly", ("AA1",),
        "Liquid precipitation accumulation section from hourly reports.",
    ),
    "cloud_cover": NOAATopic(
        "Cloud cover and ceiling", "global-hourly", ("GA1", "CIG"),
        "Sky-cover layer and ceiling-height observations.",
    ),
    "visibility": NOAATopic(
        "Visibility", "global-hourly", ("VIS",),
        "Visibility observations from hourly surface reports.",
    ),
    "weather_observations": NOAATopic(
        "Hourly present weather", "global-hourly", ("AU1", "AW1", "MW1"),
        "Automated and manual present-weather observations.",
    ),
    "wind_hourly": NOAATopic(
        "Hourly wind", "global-hourly", ("WND", "OC1"),
        "Hourly wind direction/speed and gust observations.",
    ),
    "pressure": NOAATopic(
        "Hourly atmospheric pressure", "global-hourly", ("MA1", "SLP"),
        "Station pressure and sea-level pressure observations.",
    ),
    # Monthly and yearly summaries use distinct dataset slugs but related codes.
    "temperature_monthly": NOAATopic(
        "Monthly temperature summary", "global-summary-of-the-month",
        ("TAVG", "TMAX", "TMIN", "EMXT", "EMNT"),
        "Monthly mean and extreme maximum/minimum temperatures.",
    ),
    "precipitation_monthly": NOAATopic(
        "Monthly precipitation summary", "global-summary-of-the-month",
        ("PRCP", "EMXP", "DP01", "DP10", "DP1X"),
        "Monthly total/extreme precipitation and counts above thresholds.",
    ),
    "snow_monthly": NOAATopic(
        "Monthly snowfall and snow depth summary", "global-summary-of-the-month",
        ("SNOW", "DSNW", "SNWD", "DSND", "EMSN", "EMSD"),
        "Monthly snowfall, snow depth, extremes, and threshold-day counts.",
    ),
    "snow_water_equivalent": NOAATopic(
        "Snow water equivalent", "daily-summaries", ("WESD", "WESF"),
        "Water equivalent of snow on the ground and snowfall.",
    ),
    "degree_days_monthly": NOAATopic(
        "Monthly heating and cooling degree days", "global-summary-of-the-month",
        ("HTDD", "CLDD", "HDSD", "CDSD"),
        "Heating/cooling degree-day totals and season-to-date totals.",
    ),
    "weather_counts_monthly": NOAATopic(
        "Monthly weather event counts", "global-summary-of-the-month",
        ("DYFG", "DYHF", "DYTS"),
        "Monthly counts of fog, heavy fog, and thunderstorms.",
    ),
    "temperature_annual": NOAATopic(
        "Annual temperature summary", "global-summary-of-the-year",
        ("TAVG", "TMAX", "TMIN", "EMXT", "EMNT"),
        "Annual mean and extreme maximum/minimum temperatures.",
    ),
    "precipitation_annual": NOAATopic(
        "Annual precipitation summary", "global-summary-of-the-year",
        ("PRCP", "EMXP", "DP01", "DP10", "DP1X"),
        "Annual total/extreme precipitation and counts above thresholds.",
    ),
    # Ship and buoy observations from the International Comprehensive Ocean-
    # Atmosphere Data Set (ICOADS), aggregated into spatial/time bins.
    "marine_temperature": NOAATopic(
        "Marine air, sea-surface, and dew-point temperatures", "global-marine",
        ("AIR_TEMP", "SEA_SURF_TEMP", "DEW_PT_TEMP"),
        "Ship and buoy air temperature, sea-surface temperature, and dew point.",
    ),
    "marine_precipitation": NOAATopic(
        "Marine precipitation", "global-marine", ("AMT_PRECIP",),
        "Precipitation amounts reported by marine platforms.",
    ),
    "marine_wind": NOAATopic(
        "Marine wind", "global-marine", ("WIND_DIR", "WIND_SPEED", "REL_WIND_DIR", "REL_WIND_SPD"),
        "Absolute and relative wind direction/speed from ships and buoys.",
    ),
    "marine_pressure": NOAATopic(
        "Marine sea-level pressure", "global-marine", ("SEA_LVL_PRES",),
        "Sea-level pressure observations from marine platforms.",
    ),
    "marine_wet_bulb_temperature": NOAATopic(
        "Marine wet-bulb temperature", "global-marine", ("WET_BULB_TEMP",),
        "Wet-bulb temperature observations where reported.",
    ),
    "marine_waves": NOAATopic(
        "Marine wave and swell observations", "global-marine",
        ("WAVE_DIR", "WAVE_HGT", "WAVE_PERIOD", "SWELL_DIR", "SWELL_HGT", "SWELL_PERIOD"),
        "Wave height, period, and swell direction/height measurements.",
    ),
    "marine_cloud_cover": NOAATopic(
        "Marine cloud cover", "global-marine", ("TOT_CLD_AMT", "LOW_CLD_AMT"),
        "Total and low cloud amount observations.",
    ),
    "marine_visibility": NOAATopic(
        "Marine visibility", "global-marine", ("VISIBILITY",),
        "Visibility reported by marine platforms.",
    ),
    "marine_sea_ice": NOAATopic(
        "Marine sea ice", "global-marine",
        ("CONCEN_OF_SEA_ICE", "THICKNESS_OF_I", "ICE_SIT_TREND", "TRUE_BEARING_ICE_EDGE"),
        "Sea-ice concentration, thickness, trend, and ice-edge bearing.",
    ),
}
"""Curated NOAA topic names mapped to supported dataset/data-type identifiers.

The catalog includes daily, hourly, monthly, annual, and marine in-situ
observations. Dataset type codes are case-sensitive and differ by dataset.
Use ``NOAAClient.list_topics()`` to inspect the topic labels and mappings.
"""


class NOAAError(RuntimeError):
    """Raised when the NOAA NCEI service rejects or fails a data request."""


class NOAAClient:
    """Client for the NCEI Access Data Service.

    :param timeout: Maximum time in seconds to wait for a single HTTP request.
    :type timeout: float
    :param search_radius_degrees: Half-width of the coordinate bounding box in
        degrees. The default is :data:`SEARCH_RADIUS_DEGREES`.
    :type search_radius_degrees: float
    """

    def __init__(
        self,
        *,
        timeout: float = 60.0,
        search_radius_degrees: float = SEARCH_RADIUS_DEGREES,
    ) -> None:
        self.timeout: float = timeout
        self.search_radius_degrees: float = search_radius_degrees
        self.session: requests.Session = requests.Session()

    @staticmethod
    def list_topics() -> list[tuple[str, NOAATopic]]:
        """Return all curated NOAA topic keys and their definitions.

        :returns: Topic key and metadata pairs in catalog order.
        :rtype: list[tuple[str, NOAATopic]]
        """
        return list(TOPICS.items())

    def fetch_point_data(
        self,
        *,
        request: PointDataRequest,
        output_dir: str | Path = "data/noaa",
    ) -> list[Iterator[dict[str, Any]]]:
        """Fetch grouped observations and return lazy file-backed iterators.

        :param request: Point, topic and inclusive date range to retrieve.
        :type request: PointDataRequest
        :param output_dir: Directory where the JSON response will be saved.
        :type output_dir: str or pathlib.Path
        :returns: One iterator per measurement variable. Each iterator yields
            normalized records with numeric ``value`` and lowercase
            ``description`` from the saved JSON file.
        :rtype: list[typing.Iterator[dict[str, typing.Any]]]
        :raises ValueError: If the requested topic is not in :data:`TOPICS`.
        :raises NOAAError: If the service returns an HTTP error or invalid JSON.
        """
        try:
            topic: NOAATopic = TOPICS[request.topic.lower()]
        except KeyError as exc:
            available_topics: str = ", ".join(TOPICS)
            raise ValueError(
                f"Unknown NOAA topic {request.topic!r}. Available topics: "
                f"{available_topics}"
            ) from exc

        bbox: str = self._make_bounding_box(
            request.latitude, request.longitude, self.search_radius_degrees
        )
        search_params: dict[str, str] = {
            "dataset": topic.dataset,
            "dataTypes": ",".join(topic.data_types),
            "startDate": f"{request.start_date.isoformat()}T00:00:00",
            "endDate": f"{request.end_date.isoformat()}T23:59:59",
            "bbox": bbox,
            "limit": "1000",
            "offset": "0",
        }
        search_payload: Any = self._get_json(SEARCH_URL, search_params)
        station_id: str
        selected_types: tuple[str, ...]
        station_id, selected_types = self._select_nearest_station(
            search_payload,
            request=request,
            requested_types=topic.data_types,
        )

        data_params: dict[str, str] = {
            "dataset": topic.dataset,
            "dataTypes": ",".join(selected_types),
            "stations": station_id,
            "startDate": request.start_date.isoformat(),
            "endDate": request.end_date.isoformat(),
            "includeStationName": "true",
            "includeStationLocation": "true",
            "format": "json",
            "units": "metric",
        }
        raw_payload: Any = self._get_json(BASE_URL, data_params)
        payload: list[list[dict[str, Any]]] = _normalize_observations(raw_payload)

        destination: Path = Path(output_dir)
        destination.mkdir(parents=True, exist_ok=True)
        latitude_text: str = f"{request.latitude:.4f}".replace("-", "m").replace(".", "p")
        longitude_text: str = f"{request.longitude:.4f}".replace("-", "m").replace(".", "p")
        filename: str = (
            f"{request.topic}_{latitude_text}_{longitude_text}_{station_id}_"
            f"{request.start_date.isoformat()}_{request.end_date.isoformat()}.json"
        )
        path: Path = destination / filename
        with path.open("w", encoding="utf-8") as output_file:
            json.dump(payload, output_file, ensure_ascii=False, indent=2)
            output_file.write("\n")
        descriptions: list[str] = [
            collection[0]["description"] for collection in payload if collection
        ]
        return [
            self._iter_measurements(path, description)
            for description in descriptions
        ]

    @staticmethod
    def _iter_measurements(
        path: Path,
        description: str,
    ) -> Iterator[dict[str, Any]]:
        """Yield records for one variable by streaming the saved JSON file.

        The file is parsed incrementally and filtered by ``description``;
        record collections are not loaded into memory by this iterator.

        :param path: JSON file containing nested measurement collections.
        :type path: pathlib.Path
        :param description: Lowercase variable name to select.
        :type description: str
        :yields: Individual normalized observation records.
        :ytype: dict[str, typing.Any]
        """
        if ijson is None:
            raise NOAAError(
                "The streaming JSON dependency 'ijson' is missing. Install it "
                "with 'python -m pip install -r requirements.txt'."
            )
        with path.open("rb") as input_file:
            record: dict[str, Any]
            for record in ijson.items(input_file, "item.item", use_float=True):
                if record.get("description") == description:
                    yield record

    def _get_json(self, url: str, params: dict[str, str]) -> Any:
        """Request an NCEI endpoint and decode its JSON response.

        :param url: Full NOAA service endpoint URL.
        :type url: str
        :param params: String-valued query parameters.
        :type params: dict[str, str]
        :returns: Decoded JSON response.
        :rtype: typing.Any
        :raises NOAAError: If the request fails or the response is not JSON.
        """
        response: requests.Response | None = None
        try:
            response = self.session.get(url, params=params, timeout=self.timeout)
            response.raise_for_status()
        except requests.RequestException as exc:
            body: str = response.text[:1000] if response is not None else str(exc)
            raise NOAAError(f"NOAA NCEI request failed: {body}") from exc

        try:
            payload: Any = response.json()
        except ValueError as exc:
            response_preview: str = response.text[:1000]
            raise NOAAError(
                f"NOAA NCEI returned a non-JSON response: {response_preview}"
            ) from exc
        return payload

    @staticmethod
    def _select_nearest_station(
        search_payload: Any,
        *,
        request: PointDataRequest,
        requested_types: tuple[str, ...],
    ) -> tuple[str, tuple[str, ...]]:
        """Choose the closest station with a requested data type.

        When multiple requested types are supported, stations covering more
        of them are preferred before distance is used as the tie-breaker.

        :param search_payload: Decoded response from the NOAA Search Service.
        :type search_payload: typing.Any
        :param request: Original coordinate and date range.
        :type request: PointDataRequest
        :param requested_types: Dataset-specific NCEI observation codes.
        :type requested_types: tuple[str, ...]
        :returns: Selected station identifier and data types available there.
        :rtype: tuple[str, tuple[str, ...]]
        :raises NOAAError: If the search returns no matching nearby stations.
        """
        candidates: list[tuple[int, float, str, tuple[str, ...]]] = []
        results: list[dict[str, Any]] = (
            search_payload.get("results", [])
            if isinstance(search_payload, dict)
            else []
        )
        for result in results:
            bounding_points: list[dict[str, Any]] = result.get("boundingPoints", [])
            if not bounding_points:
                continue
            coordinates: list[float] = bounding_points[0].get("coordinates", [])
            if len(coordinates) < 2:
                continue
            station_longitude: float = float(coordinates[0])
            station_latitude: float = float(coordinates[1])
            distance_km: float = NOAAClient._distance_km(
                request.latitude,
                request.longitude,
                station_latitude,
                station_longitude,
            )
            stations: list[dict[str, Any]] = result.get("stations", [])
            for station in stations:
                station_id_value: Any = station.get("id")
                if not station_id_value:
                    continue
                available_types: set[str] = {
                    str(data_type.get("id"))
                    for data_type in station.get("dataTypes", [])
                    if isinstance(data_type, dict) and data_type.get("id")
                }
                matching_types: tuple[str, ...] = tuple(
                    code for code in requested_types if code in available_types
                )
                matching_type_count: int = len(matching_types)
                if matching_type_count > 0:
                    candidates.append(
                        (
                            -matching_type_count,
                            distance_km,
                            str(station_id_value),
                            matching_types,
                        )
                    )
        if not candidates:
            raise NOAAError(
                "No NOAA station with the requested data types was found inside "
                f"the {SEARCH_RADIUS_DEGREES}-degree search area. Try a nearby "
                "coordinate or another topic."
            )
        candidates.sort()
        return candidates[0][2], candidates[0][3]

    @staticmethod
    def _distance_km(
        latitude_a: float,
        longitude_a: float,
        latitude_b: float,
        longitude_b: float,
    ) -> float:
        """Calculate great-circle distance between two geographic points.

        :param latitude_a: First latitude in decimal degrees.
        :type latitude_a: float
        :param longitude_a: First longitude in decimal degrees.
        :type longitude_a: float
        :param latitude_b: Second latitude in decimal degrees.
        :type latitude_b: float
        :param longitude_b: Second longitude in decimal degrees.
        :type longitude_b: float
        :returns: Distance in kilometers.
        :rtype: float
        """
        earth_radius_km: float = 6371.0088
        latitude_a_rad: float = math.radians(latitude_a)
        latitude_b_rad: float = math.radians(latitude_b)
        delta_latitude_rad: float = math.radians(latitude_b - latitude_a)
        delta_longitude_rad: float = math.radians(longitude_b - longitude_a)
        haversine: float = (
            math.sin(delta_latitude_rad / 2) ** 2
            + math.cos(latitude_a_rad)
            * math.cos(latitude_b_rad)
            * math.sin(delta_longitude_rad / 2) ** 2
        )
        return 2 * earth_radius_km * math.asin(math.sqrt(haversine))

    @staticmethod
    def _make_bounding_box(
        latitude: float,
        longitude: float,
        radius_degrees: float,
    ) -> str:
        """Build the NCEI bounding-box string in north, west, south, east order.

        :param latitude: Center latitude in decimal degrees.
        :type latitude: float
        :param longitude: Center longitude in decimal degrees.
        :type longitude: float
        :param radius_degrees: Half-width of each side, in degrees.
        :type radius_degrees: float
        :returns: Comma-separated ``north,west,south,east`` coordinates.
        :rtype: str
        """
        north: float = min(90.0, latitude + radius_degrees)
        west: float = max(-180.0, longitude - radius_degrees)
        south: float = max(-90.0, latitude - radius_degrees)
        east: float = min(180.0, longitude + radius_degrees)
        return f"{north},{west},{south},{east}"


__all__ = ["NOAAClient", "NOAAError", "NOAATopic", "TOPICS"]
