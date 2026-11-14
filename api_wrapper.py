"""Provider-neutral entry point for external data APIs.

Applications should create a :class:`PointDataRequest` and pass it to
:func:`fetch_data_single_topic_single_coordinate`. Provider-specific details
such as authentication, task polling and bundle download remain in each API
client module.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from pathlib import Path
from typing import Any, Iterator, Protocol, Sequence

from noaa_api import NOAAClient, NOAAError


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
}
"""Provider-name to client-class registry."""


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
    "PointDataRequest",
    "fetch_data_single_topic_single_coordinate",
    "get_all_topics_list",
]
