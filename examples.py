"""Suggested case studies to start exploring from (``GET /api/examples``).

Every case study is a ready-made request: a point, a topic and ten years of
daily data around a documented extreme event. Selecting it on the website
fills the form, runs the request and zooms the plot to the event. Each event
was checked against the data the app actually delivers (station, value and
date in ``verified``), so the case study shows what it promises.

The seven cases cover heat, cold, precipitation and snow on four continents,
measured by station networks (NOAA GHCN-Daily) and, where no long station
record is available, by the ERA5 reanalysis.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any


@dataclass(frozen=True)
class Example:
    id: str
    title: str
    """Event and year, worded like a case study (no headline)."""
    place: str
    category: str
    """``heat``, ``cold``, ``rain`` or ``snow``: sets the category label."""
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
    variable: str
    """The variable that shows the event, e.g. ``Daily max. temperature``."""
    source: str
    """Data set and station (or grid cell) of the verified value."""
    value: str
    """The verified value and date, short, for the case-study list."""

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


EXAMPLES: tuple[Example, ...] = (
    Example(
        "pnw-heat-dome-2021", "2021 Pacific Northwest heat wave", "Portland, Oregon, USA", "heat",
        "Persistent blocking high over north-western North America in late June 2021; "
        "station maxima exceeded previous records by several degrees.",
        45.52, -122.68, "temperature", "01.01.2012", "31.12.2021", "2021-06-28",
        "45.6 °C maximum on 28 June 2021, 20.5 °C above normal (NOAA, Portland KGW TV).",
        "Daily max. temperature", "NOAA GHCN-Daily · Portland KGW TV",
        "45.6 °C · 28 Jun 2021",
    ),
    Example(
        "uk-heat-2022", "UK first ≥ 40 °C day, 2022", "London Heathrow, UK", "heat",
        "First air temperature of 40 °C or more on record in the United Kingdom, "
        "during the July 2022 western European heat wave.",
        51.48, -0.45, "temperature", "01.01.2013", "31.12.2022", "2022-07-19",
        "40.2 °C maximum on 19 July 2022 (NOAA, Heathrow).",
        "Daily max. temperature", "NOAA GHCN-Daily · Heathrow",
        "40.2 °C · 19 Jul 2022",
    ),
    Example(
        "sydney-black-summer-2020", "2019–20 Australian summer heat", "Penrith, Sydney, Australia", "heat",
        "Southern-hemisphere summer heat during the 2019–20 bushfire season "
        "(Black Summer) in western Sydney.",
        -33.75, 150.69, "temperature", "01.01.2011", "31.12.2020", "2020-01-04",
        "48.9 °C maximum on 4 January 2020 (NOAA, Penrith Lakes AWS).",
        "Daily max. temperature", "NOAA GHCN-Daily · Penrith Lakes AWS",
        "48.9 °C · 4 Jan 2020",
    ),
    Example(
        "siberia-heat-2020", "2020 Siberian heat wave", "Verkhoyansk, Russia", "heat",
        "Prolonged Arctic warm anomaly in spring and early summer 2020. Shown with "
        "ERA5 reanalysis, whose grid-cell value is lower than the station reading.",
        67.55, 133.38, "temperature_era5", "01.01.2011", "31.12.2020", "2020-06-21",
        "33.9 °C maximum in the ERA5 grid cell on 21 June 2020; the station measured 38 °C on 20 June.",
        "Daily max. temperature", "ERA5 reanalysis · grid cell",
        "33.9 °C · 21 Jun 2020",
    ),
    Example(
        "texas-freeze-2021", "February 2021 North American cold wave", "Dallas–Fort Worth, Texas, USA", "cold",
        "Arctic air outbreak reaching the southern United States in mid-February 2021, "
        "with a multi-day run of minima far below normal.",
        32.90, -97.04, "temperature", "01.01.2012", "31.12.2021", "2021-02-16",
        "−18.8 °C minimum on 16 February 2021, eleven days in a row below normal (NOAA, DFW airport).",
        "Daily min. temperature", "NOAA GHCN-Daily · DFW Airport",
        "−18.8 °C · 16 Feb 2021",
    ),
    Example(
        "berlin-cloudburst-2017", "2017 Berlin convective rainfall", "Berlin, Germany", "rain",
        "Quasi-stationary thunderstorm on 29 June 2017; the daily total was "
        "comparable to the mean rainfall of two summer months.",
        52.52, 13.40, "precipitation", "01.01.2012", "31.12.2021", "2017-06-29",
        "112.8 mm on 29 June 2017 (NOAA, Berlin Tempelhof).",
        "Daily precipitation", "NOAA GHCN-Daily · Berlin-Tempelhof",
        "112.8 mm · 29 Jun 2017",
    ),
    Example(
        "snowmageddon-2010", "February 2010 Mid-Atlantic blizzards", "Washington, D.C., USA", "snow",
        "Two blizzards within one week in February 2010 produced record snow depth "
        "in the Washington–Baltimore area.",
        38.85, -77.04, "snow_depth", "01.01.2005", "31.12.2014", "2010-02-11",
        "533 mm snow depth on 11 February 2010 (NOAA, Reagan National Airport).",
        "Snow depth", "NOAA GHCN-Daily · Reagan National Airport",
        "533 mm · 11 Feb 2010",
    ),
)


def list_examples() -> list[dict[str, Any]]:
    """All case studies as JSON-friendly dicts."""
    return [example.to_dict() for example in EXAMPLES]


__all__ = ["EXAMPLES", "Example", "list_examples"]
