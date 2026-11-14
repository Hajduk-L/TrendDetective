"""Provider-neutral entry point for external data APIs.

Applications should create a :class:`PointDataRequest` and pass it to
:func:`fetch_data_single_topic_single_coordinate`. Provider-specific details
such as authentication, task polling and bundle download remain in each API
client module.
"""

from __future__ import annotations

import math
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from typing import Any, Iterator, Protocol, Sequence

from dwd_api import DWDClient
from eccc_api import ECCCClient
from fmi_api import FMIClient
from noaa_api import NOAAClient, NOAAError
from openmeteo_api import OpenMeteoClient
from polarwatch_api import PolarWatchIceClient
from station_sources import SourceError, distance_km


class PointDataProvider(Protocol):
    """Interface required of a registered provider client."""

    @staticmethod
    def list_topics() -> Sequence[tuple[str, object]]:
        """Return this provider's topic keys and corresponding definitions."""
        ...

    def fetch_point_data(
        self,
        *,
        request: PointDataRequest,
        output_dir: str | Path,
    ) -> list[Iterator[dict[str, Any]]]:
        """Fetch one coordinate and return lazy iterators by variable."""
        ...


_PROVIDERS: dict[str, type[PointDataProvider]] = {
    "noaa": NOAAClient,
    "dwd": DWDClient,
    "eccc": ECCCClient,
    "fmi": FMIClient,
    "openmeteo": OpenMeteoClient,
    "polarwatch": PolarWatchIceClient,
}
"""Provider-name to client-class registry.

None of these needs a registration or key. NOAA covers the world; DWD
(Germany), ECCC (Canada) and FMI (Finland) add their national station
networks for the shared topics (``temperature``, ``precipitation``, ...).
Open-Meteo (ERA5 model, ``*_era5`` topics) and PolarWatch (satellite ice
thickness) add topics of their own.
"""

PROVIDER_NAMES: dict[str, str] = {
    "noaa": "NOAA",
    "dwd": "DWD",
    "eccc": "ECCC",
    "fmi": "FMI",
    "openmeteo": "Open-Meteo ERA5",
    "polarwatch": "NOAA PolarWatch VIIRS",
}
"""Display names written into the ``source`` field of every record."""


@dataclass(frozen=True)
class PointDataRequest:
    """A single point's data topic and inclusive date range.

    :param latitude: Geographic latitude in decimal degrees, from -90 to 90.
    :type latitude: float
    :param longitude: Geographic longitude in decimal degrees, from -180 to 180.
    :type longitude: float
    :param topic: Provider-supported topic name, for example ``"precipitation"``.
    :type topic: str
    :param start_date: First date requested, inclusive.
    :type start_date: datetime.date
    :param end_date: Last date requested, inclusive.
    :type end_date: datetime.date
    :raises ValueError: If coordinates are out of bounds or the date range is
        reversed.
    """

    latitude: float
    longitude: float
    topic: str
    start_date: date
    end_date: date

    def __post_init__(self) -> None:
        """Validate coordinate bounds and date ordering."""
        if not -90 <= self.latitude <= 90:
            raise ValueError("latitude must be between -90 and 90")
        if not -180 <= self.longitude <= 180:
            raise ValueError("longitude must be between -180 and 180")
        if self.end_date < self.start_date:
            raise ValueError("end_date must be on or after start_date")


def fetch_data_single_topic_single_coordinate(
    request: PointDataRequest,
    *,
    provider: str = "noaa",
    output_dir: str | Path | None = None,
) -> list[Iterator[dict[str, Any]]]:
    """Fetch one topic and return one lazy iterator per measured variable.

    :param request: Point, topic and inclusive date range to retrieve.
    :type request: PointDataRequest
    :param provider: Provider registry key. Defaults to ``"noaa"``.
    :type provider: str
    :param output_dir: Parent directory where result files are stored. By
        default, files go to ``data/<provider>/``.
    :type output_dir: str, pathlib.Path, or None
    :returns: A list of iterators, one per measured variable. Each iterator
        yields records with the six shared metadata fields, ``value``, and
        ``description``. Records are read lazily from the saved JSON file.
    :rtype: list[typing.Iterator[dict[str, typing.Any]]]
    :raises ValueError: If the provider name is not registered.
    :raises NOAAError: If NOAA rejects or fails the request.
    :raises TimeoutError: If the provider task does not finish in time.
    """
    try:
        provider_key: str = provider.lower()
        client_type: type[PointDataProvider] = _PROVIDERS[provider_key]
    except KeyError as exc:
        available: str = ", ".join(sorted(_PROVIDERS))
        raise ValueError(f"Unknown provider {provider!r}. Available: {available}") from exc

    client: PointDataProvider = client_type()
    destination: Path = (
        Path(output_dir) if output_dir is not None else Path("data") / provider_key
    )
    return client.fetch_point_data(request=request, output_dir=destination)


def providers_for(topic: str, latitude: float | None = None, longitude: float | None = None) -> list[str]:
    """Registry keys of the providers offering ``topic`` (at the point, if given)."""
    keys: list[str] = []
    for key, client_type in _PROVIDERS.items():
        if topic.lower() not in {name for name, _ in client_type.list_topics()}:
            continue
        covers = getattr(client_type, "covers", None)
        if latitude is not None and longitude is not None and covers is not None:
            if not covers(latitude, longitude):
                continue
        keys.append(key)
    return keys


def _nearest_distance(records: list[dict[str, Any]], latitude: float, longitude: float) -> float:
    """Distance from the point to the station that measured ``records``."""
    for record in records:
        try:
            return distance_km(latitude, longitude, float(record["latitude"]), float(record["longitude"]))
        except (KeyError, TypeError, ValueError):
            continue
    return math.inf


def fetch_data_single_topic_nearest_station(
    request: PointDataRequest,
    *,
    output_dir: str | Path | None = None,
) -> list[list[dict[str, Any]]]:
    """Ask every provider of the topic and keep the station nearest to the point.

    All providers covering the point run in parallel. Each returns its own
    nearest station with data; the closest of those wins, so a dense national
    network (DWD, ECCC, FMI) is used where it has a station nearer than NOAA.
    Every record gets a ``source`` field naming the database.

    :returns: One record list per measured variable, like
        :func:`fetch_data_single_topic_single_coordinate` (but materialised).
    :raises RuntimeError: If no provider found a station; the message lists
        each provider's reason.
    """
    keys = providers_for(request.topic, request.latitude, request.longitude)
    if not keys:
        raise ValueError(f"No data source offers the topic {request.topic!r} at this point.")

    def run(key: str) -> list[list[dict[str, Any]]]:
        destination = Path(output_dir) / key if output_dir is not None else None
        collections = fetch_data_single_topic_single_coordinate(
            request, provider=key, output_dir=destination
        )
        result: list[list[dict[str, Any]]] = []
        for collection in collections:
            records = [dict(record) for record in collection if isinstance(record, dict)]
            for record in records:
                record.setdefault("source", PROVIDER_NAMES.get(key, key))
            if records:
                result.append(records)
        return result

    answers: list[tuple[float, float, int, list[list[dict[str, Any]]]]] = []
    errors: list[str] = []
    with ThreadPoolExecutor(max_workers=len(keys)) as pool:
        futures = {key: pool.submit(run, key) for key in keys}
        for order, (key, future) in enumerate(futures.items()):
            try:
                collections = future.result()
            except (RuntimeError, ValueError, OSError) as error:  # NOAAError/SourceError are RuntimeErrors
                errors.append(f"{PROVIDER_NAMES.get(key, key)}: {error}")
                continue
            if any(isinstance(r.get("value"), (int, float)) for c in collections for r in c):
                first = next(record for collection in collections for record in collection)
                answers.append(
                    (
                        _record_coverage(collections, request),
                        _nearest_distance([first], request.latitude, request.longitude),
                        order,
                        collections,
                    )
                )
            else:
                errors.append(f"{PROVIDER_NAMES.get(key, key)}: no values in the selected time range")
    if not answers:
        raise SourceError(" | ".join(errors) if errors else "No data source returned values.")
    # A near station that only has a few of the requested years must not beat
    # one a little farther away that covers the whole range.
    good = [answer for answer in answers if answer[0] >= GOOD_COVERAGE]
    if good:
        return min(good, key=lambda answer: (answer[1], answer[2]))[3]
    return max(answers, key=lambda answer: (answer[0], -answer[1], -answer[2]))[3]


GOOD_COVERAGE: float = 0.8
"""Share of the requested range a point answer must span to be chosen by distance alone."""


def _period(text: str) -> tuple[date, date] | None:
    """First and last day of a ``YYYY-MM-DD``, ``YYYY-MM`` or ``YYYY`` observation date."""
    try:
        if len(text) >= 10:
            day = date.fromisoformat(text[:10])
            return day, day
        if len(text) == 7:
            year, month = int(text[:4]), int(text[5:7])
            return date(year, month, 1), date(year + month // 12, month % 12 + 1, 1)
        if len(text) == 4:
            return date(int(text), 1, 1), date(int(text), 12, 31)
    except ValueError:
        pass
    return None


def _record_coverage(collections: list[list[dict[str, Any]]], request: PointDataRequest) -> float:
    """Share of the requested range between the first and last observation."""
    periods = [
        period
        for collection in collections
        for record in collection
        if isinstance(record.get("value"), (int, float))
        and (period := _period(str(record.get("date")))) is not None
    ]
    if not periods:
        return 0.0
    first = max(min(start for start, _ in periods), request.start_date)
    last = min(max(end for _, end in periods), request.end_date)
    requested = (request.end_date - request.start_date).days + 1
    return max(0.0, min(1.0, ((last - first).days + 1) / requested))


def get_all_topics_list() -> list[str]:
    """Collect the topic keys exposed by every registered API provider.

    Each provider must expose a ``list_topics`` method that returns topic key
    and metadata pairs, such as ``(topic_name, topic_definition)``. Duplicate
    topic keys are included only once, in the order providers and topics are
    registered.

    :returns: Unique user-facing topic names available across all providers.
    :rtype: list[str]
    """
    all_topic_names: list[str] = []
    seen_topic_names: set[str] = set()

    for client_type in _PROVIDERS.values():
        for topic_name, _topic_definition in client_type.list_topics():
            if topic_name not in seen_topic_names:
                all_topic_names.append(topic_name)
                seen_topic_names.add(topic_name)

    return all_topic_names


__all__ = [
    "PROVIDER_NAMES",
    "PointDataRequest",
    "fetch_data_single_topic_nearest_station",
    "fetch_data_single_topic_single_coordinate",
    "get_all_topics_list",
    "providers_for",
]
