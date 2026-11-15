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
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import date, timedelta
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
"""Half-width in degrees of the first, smallest station search box."""

MOVING_PLATFORM_DATASETS: frozenset[str] = frozenset({"global-marine"})
"""Datasets whose platforms move (ships, buoys) and need a bounding box."""

MARINE_BOX_DEGREES: float = 1.0
"""Half-width of the box whose ship and buoy reports are combined.

The Search Service matches a platform by the extent of its whole track, so
it reports marine "stations" next to any point (even inland) and cannot be
used to size the box. About 1 degree collects enough reports at sea; a
smaller box often holds only a handful of passing ships per month.
"""

MAX_MARINE_MONTHS: int = 24
"""Longest marine request (months). Reports are fetched month by month (about
14 s each, two at a time, so two years take about three minutes; past months
are cached); a busy box near a coast holds ~90,000 reports per month. Longer
ranges get a clear error pointing to the ERA5 topics instead of a request
that runs into a timeout."""

MARINE_THIN_HOURS: int = 3
"""One report per platform in each block of this many hours is kept."""


def _thin_marine_rows(rows: list[Any]) -> list[Any]:
    """Keep one raw report per platform and :data:`MARINE_THIN_HOURS`-hour block.

    Moored buoys report every 10 minutes; for daily or longer intervals one
    report every few hours per platform carries the same information at a
    fraction of the memory (91,510 -> a few thousand rows for a month off Boston).
    """
    kept: list[Any] = []
    seen: set[tuple[Any, str, int]] = set()
    for row in rows:
        if not isinstance(row, dict):
            continue
        stamp = str(row.get("DATE") or "")
        try:
            hour = int(stamp[11:13]) if len(stamp) >= 13 else 0
        except ValueError:
            hour = 0
        key = (row.get("STATION"), stamp[:10], hour // MARINE_THIN_HOURS)
        if key in seen:
            continue
        seen.add(key)
        kept.append(row)
    return kept

MARINE_PARALLEL_REQUESTS: int = 2
"""Marine months fetched at the same time. Two run as fast as one; with four,
NOAA stalled every request until the 120 s limit."""

MARINE_CACHE_DIR: Path = Path("data/cache/marine")
"""Finished past months are stored here; ship reports of a past month do not change."""

_VISIBILITY_KM: dict[int, float] = {
    90: 0.05, 91: 0.05, 92: 0.2, 93: 0.5, 94: 1.0, 95: 2.0, 96: 4.0, 97: 10.0, 98: 20.0, 99: 50.0,
}
"""WMO code table 4377 (ship visibility codes 90-99) as distance in km (90 = below 50 m, 99 = 50 km or more)."""

_MARINE_VALID: dict[str, tuple[float, float]] = {
    "wind_dir": (0.0, 360.0),  # 361/362 = variable or calm, not a direction
    "rel_wind_dir": (0.0, 360.0),
    "tot_cld_amt": (0.0, 8.0),  # 9 = sky obscured, not an amount of oktas
    "low_cld_amt": (0.0, 8.0),
    "sea_surf_temp": (-2.5, 40.0),
    "air_temp": (-70.0, 60.0),
    "dew_pt_temp": (-80.0, 40.0),
    "wet_bulb_temp": (-70.0, 45.0),
    "sea_lvl_pres": (850.0, 1090.0),
}
"""Physically possible range of marine values; anything outside is a code or an error."""


def _clean_marine_rows(collections: list[list[dict[str, Any]]]) -> list[list[dict[str, Any]]]:
    """Make ship and buoy reports usable as a time series.

    * code values outside :data:`_MARINE_VALID` are dropped,
    * ``visibility`` codes 90-99 become kilometres,
    * one report per platform, variable and hour is kept: a moored buoy
      reporting every 10 minutes would otherwise outweigh every ship in the
      box (4,459 of 4,628 rows in one test month). Raw rows are already
      thinned per download (:func:`_thin_marine_rows`).
    """
    cleaned: list[list[dict[str, Any]]] = []
    for collection in collections:
        seen: set[tuple[Any, str, str]] = set()
        kept: list[dict[str, Any]] = []
        for record in collection:
            code = str(record.get("description") or "")
            value = record.get("value")
            if code == "visibility":
                if not isinstance(value, (int, float)) or int(value) not in _VISIBILITY_KM:
                    continue
                record = {**record, "value": _VISIBILITY_KM[int(value)], "unit": "km"}
            elif code in _MARINE_VALID and isinstance(value, (int, float)):
                low, high = _MARINE_VALID[code]
                if not low <= value <= high:
                    continue
            hour = str(record.get("date") or "")[:13]
            key = (record.get("station"), code, hour)
            if key in seen:
                continue
            seen.add(key)
            kept.append(record)
        if kept:
            cleaned.append(kept)
    return cleaned


MAX_STATION_ATTEMPTS: int = 5
"""Nearest matching stations tried until one has values in the date range."""

SEARCH_RADII_DEGREES: tuple[float, ...] = (0.05, 0.25, 0.5, 1.0, 2.0)
"""Search box half-widths tried in order until a matching station is found.

The search starts close to the requested point and widens step by step, so
the nearest station is used when one exists nearby, and remote points still
get the closest available station instead of an error.
"""
"""Half-width of the latitude/longitude bounding box around the point.

The resulting query area is approximately 11 km north-south by 11 km east-west
at the equator; longitude width narrows toward the poles.
"""


_TEMPERATURE_CODES: tuple[str, ...] = (
    "TMAX", "TMIN", "TAVG", "TOBS", "ADPT", "AWBT", "EMXT", "EMNT",
    "MNPN", "MXPN", "AIR_TEMP", "SEA_SURF_TEMP", "DEW_PT_TEMP", "WET_BULB_TEMP",
)
_MILLIMETRE_CODES: tuple[str, ...] = (
    "PRCP", "MDPR", "SNOW", "MDSF", "SNWD", "EVAP", "THIC", "WESD", "WESF",
    "EMXP", "EMSN", "EMSD",
)
_SPEED_CODES: tuple[str, ...] = (
    "AWND", "WSF1", "WSF2", "WSF5", "WSFG", "WSFI", "WSFM",
)
_DIRECTION_CODES: tuple[str, ...] = (
    "AWDR", "WDF1", "WDF2", "WDF5", "WDFG", "WDFI", "WDFM",
)
_DAY_COUNT_CODES: tuple[str, ...] = (
    "DP01", "DP10", "DP1X", "DSNW", "DSND", "DYFG", "DYHF", "DYTS",
)

DATA_TYPE_UNITS: dict[str, str] = {
    **{code: "°C" for code in _TEMPERATURE_CODES},
    **{code: "mm" for code in _MILLIMETRE_CODES},
    **{code: "m/s" for code in _SPEED_CODES},
    **{code: "°" for code in _DIRECTION_CODES},
    **{code: "days" for code in _DAY_COUNT_CODES},
    "RHAV": "%", "RHMN": "%", "RHMX": "%",
    "ASLP": "hPa", "ASTP": "hPa", "SEA_LVL_PRES": "hPa",
    "PSUN": "%",
    "HTDD": "°C·days", "CLDD": "°C·days", "HDSD": "°C·days", "CDSD": "°C·days",
}
"""Units of the NCEI codes when requested with ``units=metric``.

Hourly ISD fields get their units from :data:`_ISD_FIELDS` instead. Codes
not listed (cloud codes, weather-type flags, most marine fields) get no unit,
and the frontend shows none.
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


_IGNORED_FIELDS: frozenset[str] = frozenset(
    {"report_type", "quality_control", "source", "call_sign"}
)
"""Per-report metadata columns of ``global-hourly`` that are not measurements."""

_ISD_ERRONEOUS_QUALITY: frozenset[str] = frozenset({"3", "7"})
"""ISD quality codes marking a value as erroneous."""

# (output suffix, value index, quality index, divisor, missing value, unit)
_IsdPart = tuple[str, int, int, int, str, str]
_ISD_FIELDS: dict[str, tuple[_IsdPart, ...]] = {
    "tmp": (("", 0, 1, 10, "+9999", "°C"),),
    "dew": (("", 0, 1, 10, "+9999", "°C"),),
    "slp": (("", 0, 1, 10, "99999", "hPa"),),
    "wnd": (
        ("_direction", 0, 1, 1, "999", "°"),
        ("_speed", 3, 4, 10, "9999", "m/s"),
    ),
    "oc1": (("_gust", 0, 1, 10, "9999", "m/s"),),
    "ma1": (
        ("_altimeter", 0, 1, 10, "99999", "hPa"),
        ("_station_pressure", 2, 3, 10, "99999", "hPa"),
    ),
    "vis": (("", 0, 1, 1, "999999", "m"),),
    "cig": (("", 0, 1, 1, "99999", "m"),),
    "ga1": (
        ("_coverage", 0, 1, 1, "99", "oktas"),
        ("_base_height", 2, 3, 1, "+99999", "m"),
    ),
}
"""Layout of comma-separated ISD fields returned by ``global-hourly``.

The Access Data Service returns these sections as raw ISD strings such as
``TMP = "+0106,5"`` (10.6 °C, quality 5) or ``WND = "200,5,N,0026,5"``
(200°, 2.6 m/s). Scaling and missing values follow the NCEI ISD format
documentation. ``AA1`` and ``RH1`` depend on a period/kind prefix and are
handled in :func:`_parse_isd_field`; present-weather codes (``AU1``, ``AW1``,
``MW1``) are categorical and stay unparsed text.
"""

_RH1_KINDS: dict[str, str] = {"M": "mean", "N": "min", "X": "max"}


def _isd_number(text: str, quality: str, divisor: int, missing: str) -> float | None:
    """Scale one ISD number, or return ``None`` if missing or erroneous."""
    if text == missing or text.lstrip("+-") == missing.lstrip("+-"):
        return None
    if quality in _ISD_ERRONEOUS_QUALITY:
        return None
    try:
        number: int = int(text)
    except ValueError:
        return None
    return number / divisor if divisor != 1 else float(number)


def _parse_isd_field(
    name: str, raw_value: Any
) -> list[tuple[str, float, str]] | None:
    """Split a coded ``global-hourly`` field into numeric variables.

    :param name: Lowercase NCEI field name, for example ``"tmp"``.
    :type name: str
    :param raw_value: Raw field value from the response.
    :type raw_value: typing.Any
    :returns: ``(description, value, unit)`` tuples (possibly empty when the
        value is missing), or ``None`` if ``name`` is not a known ISD field.
    :rtype: list[tuple[str, float, str]] or None
    """
    if not isinstance(raw_value, str):
        return None
    parts: list[str] = raw_value.split(",")
    if name == "aa1":
        # period hours, depth (mm x 10), condition, quality
        if len(parts) < 4:
            return []
        depth = _isd_number(parts[1], parts[3], 10, "9999")
        if depth is None or parts[0] == "99":
            return []
        return [(f"aa1_{int(parts[0])}h", depth, "mm")]
    if name == "rh1":
        # period hours, kind (M/N/X), percent, derived code, quality
        if len(parts) < 5 or parts[1] not in _RH1_KINDS:
            return []
        percent = _isd_number(parts[2], parts[4], 1, "999")
        if percent is None or parts[0] == "999":
            return []
        return [(f"rh1_{_RH1_KINDS[parts[1]]}_{int(parts[0])}h", percent, "%")]
    layout: tuple[_IsdPart, ...] | None = _ISD_FIELDS.get(name)
    if layout is None:
        return None
    values: list[tuple[str, float, str]] = []
    for suffix, value_index, quality_index, divisor, missing, unit in layout:
        if max(value_index, quality_index) >= len(parts):
            continue
        number = _isd_number(
            parts[value_index], parts[quality_index], divisor, missing
        )
        if number is None:
            continue
        if name == "ga1" and suffix == "_coverage" and number > 8:
            continue  # 09 obscured, 10 partially obscured: no okta amount
        if name == "cig" and number == 22000:
            continue  # 22000 means "unlimited" ceiling, not a height
        values.append((name + suffix, number, unit))
    return values


GOOD_RECORD_COVERAGE: float = 0.8
"""Share of the requested range a station's record must span to be ranked by distance."""


def _normalize_observations(payload: Any) -> list[list[dict[str, Any]]]:
    """Group observations into one record collection per measured variable.

    The result is a list of collections, one for each measured variable. Every
    record contains the six normalized station metadata fields, plus a numeric
    ``value`` when NOAA provides one, lowercase variable ``description`` and
    ``unit`` (from :data:`DATA_TYPE_UNITS`, ``None`` if unknown).
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
            if description in _STANDARD_FIELDS or description in _IGNORED_FIELDS:
                continue
            isd_values = _parse_isd_field(description, raw_value)
            if isd_values is not None:
                for isd_description, isd_value, isd_unit in isd_values:
                    collections_by_description.setdefault(
                        isd_description, []
                    ).append(
                        {
                            **metadata,
                            "value": isd_value,
                            "description": isd_description,
                            "unit": isd_unit,
                        }
                    )
                continue
            value: float | int | str | None = _as_number(raw_value)
            if value is not None:
                collections_by_description.setdefault(description, []).append(
                    {
                        **metadata,
                        "value": value,
                        "description": description,
                        "unit": DATA_TYPE_UNITS.get(description.upper()),
                    }
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

    :param timeout: Maximum time in seconds to connect or to wait for the next
        bytes of a response.
    :type timeout: float
    :param max_request_seconds: Maximum total time in seconds for one HTTP
        request, including a slowly trickling response body.
    :type max_request_seconds: float
    :param search_radii_degrees: Half-widths of the coordinate bounding box in
        degrees, tried in ascending order until a station is found. The
        default is :data:`SEARCH_RADII_DEGREES`.
    :type search_radii_degrees: tuple[float, ...]
    """

    def __init__(
        self,
        *,
        timeout: float = 60.0,
        max_request_seconds: float = 120.0,
        search_radii_degrees: tuple[float, ...] = SEARCH_RADII_DEGREES,
    ) -> None:
        if not search_radii_degrees or any(r <= 0 for r in search_radii_degrees):
            raise ValueError("search_radii_degrees must contain positive values.")
        self.timeout: float = timeout
        self.max_request_seconds: float = max_request_seconds
        self.search_radii_degrees: tuple[float, ...] = tuple(
            sorted(search_radii_degrees)
        )
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

        data_params: dict[str, str] = {
            "dataset": topic.dataset,
            "startDate": request.start_date.isoformat(),
            "endDate": request.end_date.isoformat(),
            "includeStationName": "true",
            "includeStationLocation": "true",
            "format": "json",
            "units": "metric",
        }
        station_id: str
        payload: list[list[dict[str, Any]]]
        if topic.dataset in MOVING_PLATFORM_DATASETS:
            # Ships and buoys move, and the service requires a bounding box for
            # these datasets. One ship rarely passes the same box twice, so all
            # platforms inside the box are combined into one series. Bounding-
            # box requests are limited to one month, so the range is split
            # into calendar months and the rows are concatenated.
            station_id = "marine"
            data_params["dataTypes"] = ",".join(topic.data_types)
            data_params["boundingBox"] = self._make_bounding_box(
                request.latitude, request.longitude, MARINE_BOX_DEGREES
            )
            raw_payload = self._fetch_marine_months(request, dict(data_params))
            payload = _clean_marine_rows(_normalize_observations(raw_payload))
        else:
            # The Search Service matches a station's whole period of record,
            # so the nearest match often stopped reporting these codes years
            # ago. The nearest few candidates are tried until one has values
            # in the requested range.
            candidates: list[tuple[str, tuple[str, ...]]]
            candidates, _ = self._find_station(request, topic)
            for station_id, selected_types in candidates[:MAX_STATION_ATTEMPTS]:
                data_params["dataTypes"] = ",".join(selected_types)
                data_params["stations"] = station_id
                payload = _normalize_observations(
                    self._get_json(BASE_URL, data_params)
                )
                if any(
                    isinstance(record["value"], (int, float))
                    for collection in payload
                    for record in collection
                ):
                    break

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
        # ``timeout`` only limits the connect and each single socket read, so a
        # server that keeps trickling bytes would never time out. The body is
        # therefore read in chunks against a total deadline.
        deadline: float = time.monotonic() + self.max_request_seconds
        response: requests.Response | None = None
        try:
            response = self.session.get(
                url, params=params, timeout=self.timeout, stream=True
            )
            chunks: list[bytes] = []
            for chunk in response.iter_content(chunk_size=64 * 1024):
                chunks.append(chunk)
                if time.monotonic() > deadline:
                    raise NOAAError(
                        "NOAA NCEI did not finish sending data within "
                        f"{self.max_request_seconds:.0f} seconds. Try a shorter "
                        "time range or a smaller area."
                    )
            body_bytes: bytes = b"".join(chunks)
            response.raise_for_status()
        except requests.RequestException as exc:
            body: str = (
                body_bytes.decode("utf-8", "replace")[:1000]
                if response is not None and "body_bytes" in locals()
                else str(exc)
            )
            raise NOAAError(f"NOAA NCEI request failed: {body}") from exc
        finally:
            if response is not None:
                response.close()

        try:
            payload: Any = json.loads(body_bytes)
        except ValueError as exc:
            response_preview: str = body_bytes.decode("utf-8", "replace")[:1000]
            raise NOAAError(
                f"NOAA NCEI returned a non-JSON response: {response_preview}"
            ) from exc
        return payload

    def _find_station(
        self,
        request: PointDataRequest,
        topic: NOAATopic,
    ) -> tuple[list[tuple[str, tuple[str, ...]]], float]:
        """Search for stations in growing boxes around the requested point.

        Each radius in :attr:`search_radii_degrees` is tried in order; the
        first box that contains a station with matching data wins, and its
        stations are returned ranked by :meth:`_rank_stations`.

        Each box is searched once without a ``dataTypes`` filter (the
        Service would only return stations reporting *all* listed codes);
        the codes are matched locally. Only when a dense box was cut off at
        1000 results and nothing matched is the topic's main code searched
        explicitly, so a box costs at most two requests.

        :param request: Point, topic and inclusive date range to retrieve.
        :type request: PointDataRequest
        :param topic: Catalog entry with dataset and observation codes.
        :type topic: NOAATopic
        :returns: Ranked ``(station id, data types available there)`` pairs,
            best first, and the search radius in degrees used to find them.
        :rtype: tuple[list[tuple[str, tuple[str, ...]]], float]
        :raises NOAAError: If even the largest box contains no matching station.
        """
        fallback: tuple[list[tuple[str, tuple[str, ...]]], float] | None = None
        for radius in self.search_radii_degrees:
            bbox: str = self._make_bounding_box(
                request.latitude, request.longitude, radius
            )
            base_params: dict[str, str] = {
                "dataset": topic.dataset,
                "startDate": f"{request.start_date.isoformat()}T00:00:00",
                "endDate": f"{request.end_date.isoformat()}T23:59:59",
                "bbox": bbox,
                "limit": "1000",
                "offset": "0",
            }
            # One search without a code filter: every station lists its codes,
            # so they are matched locally (_rank_stations). Searching each code
            # on its own cost up to ~185 requests for a topic with many codes.
            search_payload: Any = self._get_json(SEARCH_URL, base_params)
            results: list[Any] = (
                list(search_payload.get("results", [])) if isinstance(search_payload, dict) else []
            )
            truncated = isinstance(search_payload, dict) and int(
                search_payload.get("count", 0) or 0
            ) > len(results)
            ranked = self._rank_with_coverage(
                {"results": results}, request=request, requested_types=topic.data_types
            )
            if not ranked and truncated:
                # A dense box can hide matching stations beyond the first
                # 1000 results: ask once more for the topic's main code.
                filtered: Any = self._get_json(
                    SEARCH_URL, {**base_params, "dataTypes": topic.data_types[0]}
                )
                if isinstance(filtered, dict):
                    ranked = self._rank_with_coverage(
                        filtered, request=request, requested_types=topic.data_types
                    )
            if ranked and ranked[0][2]:
                return [(station, types) for station, types, _ in ranked], radius
            if ranked and fallback is None:
                # Only short records here: look a little farther for a
                # station covering the range, but keep these as a fallback.
                fallback = ([(station, types) for station, types, _ in ranked], radius)
        if fallback is not None:
            return fallback
        raise NOAAError(
            "No NOAA station with the requested data types was found within "
            f"{self.search_radii_degrees[-1]} degrees of the selected point. "
            "Try another location, time range or topic."
        )

    @staticmethod
    def _rank_stations(
        search_payload: Any,
        *,
        request: PointDataRequest,
        requested_types: tuple[str, ...],
    ) -> list[tuple[str, tuple[str, ...]]]:
        """Ranked ``(station id, matching codes)``; see :meth:`_rank_with_coverage`."""
        return [
            (station, types)
            for station, types, _ in NOAAClient._rank_with_coverage(
                search_payload, request=request, requested_types=requested_types
            )
        ]

    @staticmethod
    def _rank_with_coverage(
        search_payload: Any,
        *,
        request: PointDataRequest,
        requested_types: tuple[str, ...],
    ) -> list[tuple[str, tuple[str, ...], bool]]:
        """Rank the stations that report at least one requested data type.

        Stations whose period of record spans at least
        :data:`GOOD_RECORD_COVERAGE` of the requested range come first,
        nearest first; then stations with shorter records, longest first. A
        station reporting the topic's main code (e.g. ``PRCP``) beats one
        that only reports secondary codes. The number of matching codes only
        breaks ties: counting it first made short-lived volunteer rain gauges
        (which also report ``MDPR``/``DAPR``) win over long-running airport
        stations nearby.

        :param search_payload: Decoded response from the NOAA Search Service.
        :type search_payload: typing.Any
        :param request: Original coordinate and date range.
        :type request: PointDataRequest
        :param requested_types: Dataset-specific NCEI observation codes.
        :type requested_types: tuple[str, ...]
        :returns: ``(station id, matching data types)`` pairs, best first and
            without duplicates; empty if no station matches.
        :rtype: list[tuple[str, tuple[str, ...]]]
        """
        candidates: list[tuple[tuple[Any, ...], str, tuple[str, ...]]] = []
        requested_days = (request.end_date - request.start_date).days + 1
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
            coverage = 1.0
            try:
                first = date.fromisoformat(str(result.get("startDate"))[:10])
                last = date.fromisoformat(str(result.get("endDate"))[:10])
                overlap = (min(last, request.end_date) - max(first, request.start_date)).days + 1
                coverage = max(0.0, overlap / requested_days)
            except ValueError:
                pass  # no period given: rank by distance only
            good = coverage >= GOOD_RECORD_COVERAGE
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
                    key = (
                        not good,
                        requested_types[0] not in available_types,
                        distance_km if good else -coverage,
                        -matching_type_count,
                        distance_km,
                    )
                    candidates.append((key, str(station_id_value), matching_types))
        candidates.sort(key=lambda candidate: candidate[0])
        ranked: dict[str, tuple[tuple[str, ...], bool]] = {}
        for key, station_id, matching_types in candidates:
            # key[0] is "not good": the record spans < GOOD_RECORD_COVERAGE.
            ranked.setdefault(station_id, (matching_types, not key[0]))
        return [(station, types, good) for station, (types, good) in ranked.items()]

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

    def _fetch_marine_months(self, request: PointDataRequest, params: dict[str, str]) -> list[Any]:
        """All marine rows of the range: months in parallel, past months cached.

        A failing month is skipped (its reports are missing) instead of
        discarding the whole series; if every month fails the first error is
        raised.

        :raises ValueError: If the range is longer than :data:`MAX_MARINE_MONTHS`.
        """
        months = self._month_chunks(request.start_date, request.end_date)
        if len(months) > MAX_MARINE_MONTHS:
            raise ValueError(
                f"Ship and buoy reports are fetched month by month; {len(months)} months would take too long. "
                f"Choose at most {MAX_MARINE_MONTHS // 12} years, or use an ERA5 topic for long series."
            )
        recent = date.today() - timedelta(days=60)

        def fetch(chunk: tuple[date, date]) -> list[Any]:
            first, last = chunk
            key = "_".join(
                [params["dataset"], params["dataTypes"].replace(",", "-"), params["boundingBox"].replace(",", "_"), first.isoformat(), last.isoformat()]
            )
            cache = MARINE_CACHE_DIR / f"{key}.json"
            if last < recent and cache.exists():
                try:
                    return json.loads(cache.read_text(encoding="utf-8"))
                except (OSError, ValueError):
                    pass
            client = NOAAClient(timeout=self.timeout, max_request_seconds=self.max_request_seconds)
            rows = client._get_json(BASE_URL, {**params, "startDate": first.isoformat(), "endDate": last.isoformat()})
            rows = _thin_marine_rows(rows if isinstance(rows, list) else [])
            if last < recent:
                try:
                    cache.parent.mkdir(parents=True, exist_ok=True)
                    temporary = cache.with_name(f"{cache.name}.{id(rows)}.part")
                    temporary.write_text(json.dumps(rows), encoding="utf-8")
                    temporary.replace(cache)
                except OSError:
                    pass  # read-only file system: no cache
            return rows

        rows: list[Any] = []
        errors: list[Exception] = []
        with ThreadPoolExecutor(max_workers=MARINE_PARALLEL_REQUESTS) as pool:
            for future in [pool.submit(fetch, chunk) for chunk in months]:
                try:
                    rows.extend(future.result())
                except NOAAError as error:
                    errors.append(error)
        if errors and len(errors) == len(months):
            raise errors[0]
        return rows

    @staticmethod
    def _month_chunks(start: date, end: date) -> list[tuple[date, date]]:
        """Split an inclusive date range at calendar-month boundaries.

        :param start: First date, inclusive.
        :type start: datetime.date
        :param end: Last date, inclusive.
        :type end: datetime.date
        :returns: Inclusive ``(start, end)`` pairs, each inside one month.
        :rtype: list[tuple[datetime.date, datetime.date]]
        """
        chunks: list[tuple[date, date]] = []
        chunk_start: date = start
        while chunk_start <= end:
            next_month: date = (
                date(chunk_start.year + 1, 1, 1)
                if chunk_start.month == 12
                else date(chunk_start.year, chunk_start.month + 1, 1)
            )
            chunk_end: date = min(end, next_month - timedelta(days=1))
            chunks.append((chunk_start, chunk_end))
            chunk_start = next_month
        return chunks

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
