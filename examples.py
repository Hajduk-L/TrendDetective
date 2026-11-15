"""Famous weather events to start exploring from (``GET /api/examples``).

Every example is a ready-made request: a point, a topic and ten years of
daily data around a well-known event. Clicking it on the website fills the
form, runs the request and jumps to the event in the plot. Each event was
checked against the data the app actually delivers (station, value and
date in ``verified``), so the example shows what it promises.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any


@dataclass(frozen=True)
class Example:
    id: str
    title: str
    place: str
    category: str
    """``heat``, ``cold``, ``rain`` or ``snow``: sets the icon and colour."""
    summary: str
    latitude: float
    longitude: float
    topic: str
    start: str
    """First day, ``DD.MM.YYYY``."""
    end: str
    focus: str
    """Day of the event, ``YYYY-MM-DD``; the plot zooms to it."""
    verified: str
    """What the app's data shows on that day."""

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


EXAMPLES: tuple[Example, ...] = (
    Example(
        "pnw-heat-dome-2021", "Pacific Northwest heat dome", "Portland, Oregon", "heat",
        "A 'heat dome' pushed temperatures in the normally mild Pacific Northwest far beyond any earlier record.",
        45.52, -122.68, "temperature", "01.01.2012", "31.12.2021", "2021-06-28",
        "45.6 °C maximum on 28 June 2021, 20.5 °C above normal (NOAA, Portland KGW TV).",
    ),
    Example(
        "lytton-2021", "Canada's temperature record", "Lytton, British Columbia", "heat",
        "During the same heat dome Lytton reached Canada's highest temperature ever measured; the village burned down a day later.",
        50.23, -121.58, "temperature", "01.01.2012", "31.12.2021", "2021-06-29",
        "49.6 °C maximum on 29 June 2021 (ECCC, Lytton RCS).",
    ),
    Example(
        "uk-heat-2022", "UK passes 40 °C", "London Heathrow", "heat",
        "On 19 July 2022 the United Kingdom recorded more than 40 °C for the first time.",
        51.48, -0.45, "temperature", "01.01.2013", "31.12.2022", "2022-07-19",
        "40.2 °C maximum on 19 July 2022 (NOAA, Heathrow).",
    ),
    Example(
        "paris-heat-2019", "European heat wave 2019", "Paris", "heat",
        "The July 2019 heat wave broke the all-time record of Paris, kept since 1947.",
        48.86, 2.35, "temperature", "01.01.2010", "31.12.2019", "2019-07-25",
        "42.6 °C maximum on 25 July 2019 (NOAA, Paris Montsouris).",
    ),
    Example(
        "sydney-black-summer-2020", "Black Summer heat", "Penrith, Sydney", "heat",
        "During Australia's 'Black Summer' of bushfires western Sydney became one of the hottest places on Earth.",
        -33.75, 150.69, "temperature", "01.01.2011", "31.12.2020", "2020-01-04",
        "48.9 °C maximum on 4 January 2020 (NOAA, Penrith Lakes AWS).",
    ),
    Example(
        "siberia-heat-2020", "Arctic heat in Siberia", "Verkhoyansk, Siberia", "heat",
        "A town known as one of the coldest on Earth saw a record-breaking Arctic heat wave in June 2020. "
        "Shown with ERA5 model data, which covers any place on Earth.",
        67.55, 133.38, "temperature_era5", "01.01.2011", "31.12.2020", "2020-06-21",
        "33.9 °C maximum in the ERA5 grid cell on 21 June 2020; the station measured 38 °C on 20 June.",
    ),
    Example(
        "texas-freeze-2021", "Texas deep freeze", "Dallas–Fort Worth", "cold",
        "An Arctic outbreak in February 2021 froze Texas and caused a collapse of its power grid.",
        32.90, -97.04, "temperature", "01.01.2012", "31.12.2021", "2021-02-16",
        "−18.8 °C minimum on 16 February 2021, eleven days in a row below normal (NOAA, DFW airport).",
    ),
    Example(
        "berlin-cloudburst-2017", "Berlin cloudburst", "Berlin", "rain",
        "On 29 June 2017 a stationary thunderstorm dropped more rain on Berlin than usually falls in two months.",
        52.52, 13.40, "precipitation", "01.01.2012", "31.12.2021", "2017-06-29",
        "112.8 mm on 29 June 2017 (NOAA, Berlin Tempelhof).",
    ),
    Example(
        "ahr-flood-2021", "Ahr valley flood", "Bad Neuenahr-Ahrweiler", "rain",
        "Extreme rain on 14 July 2021 caused the deadly floods in the Ahr valley and across western Germany.",
        50.54, 7.10, "precipitation", "01.01.2012", "31.12.2021", "2021-07-14",
        "66.2 mm on 14 July 2021, the wettest day of the decade at the station (NOAA, Bad Ahrweiler-Neuenahr).",
    ),
    Example(
        "harvey-2017", "Hurricane Harvey", "Houston, Texas", "rain",
        "Harvey stalled over Houston in August 2017 and brought the largest rainfall of any US hurricane on record.",
        29.64, -95.28, "precipitation", "01.01.2008", "31.12.2017", "2017-08-27",
        "529 mm on 27 August 2017 (NOAA, South Houston 4.0 SSW).",
    ),
    Example(
        "snowmageddon-2010", "Snowmageddon", "Washington, D.C.", "snow",
        "Two blizzards within a week in February 2010 buried the US capital under record snow.",
        38.85, -77.04, "snow_depth", "01.01.2005", "31.12.2014", "2010-02-11",
        "533 mm snow depth on 11 February 2010 (NOAA, Reagan National Airport).",
    ),
)


def list_examples() -> list[dict[str, Any]]:
    """All examples as JSON-friendly dicts."""
    return [example.to_dict() for example in EXAMPLES]


__all__ = ["EXAMPLES", "Example", "list_examples"]
