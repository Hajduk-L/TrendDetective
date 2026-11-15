"""Write the station outline of every area region (``data/region_outlines.json``).

The map's Areas button draws each region as the convex hull of its
measuring stations (with the same border as an area result) instead of the
region's search box, so the user sees which area the stations actually
cover before applying. The stations are found exactly like an area request
does (:func:`area_analysis._gather_stations`: all databases, duplicates
removed, at most :data:`area_analysis.MAX_STATIONS` spread over the box)
for daily temperature and precipitation over a reference period.

Run again after changing :data:`area_analysis.REGIONS`::

    .venv/bin/python region_outlines.py            # 2015–2024
    .venv/bin/python region_outlines.py 2005 2024  # another period
"""

from __future__ import annotations

import json
import sys
from concurrent.futures import ThreadPoolExecutor
from datetime import date

import area_analysis
import noaa_api

TOPICS: tuple[str, ...] = ("temperature", "precipitation")
"""Topics with an outline; other topics fall back to the temperature outline."""


def region_outline(region: area_analysis.Region, topic: str, start: date, end: date) -> dict | None:
    """Hull polygon of the stations an area request for ``topic`` would use, or ``None``."""
    stations, _, _, errors = area_analysis._gather_stations(
        noaa_api.NOAAClient(), region, topic, start, end
    )
    if len(stations) < area_analysis.MIN_STATIONS:
        print(f"  {region.id} {topic}: only {len(stations)} stations {errors or ''}", file=sys.stderr)
        return None
    print(f"  {region.id} {topic}: {len(stations)} stations", file=sys.stderr)
    return area_analysis.hull_polygon([(s.longitude, s.latitude) for s in stations], region)


def build(start: date, end: date) -> dict:
    """``{"period": [...], "regions": {id: {topic: polygon}}}`` for every region."""
    jobs = [(region, topic) for region in area_analysis.REGIONS for topic in TOPICS]
    with ThreadPoolExecutor(max_workers=4) as pool:
        outlines = list(pool.map(lambda job: region_outline(job[0], job[1], start, end), jobs))
    regions: dict[str, dict] = {}
    for (region, topic), outline in zip(jobs, outlines):
        if outline is not None:
            regions.setdefault(region.id, {})[topic] = outline
    return {"period": [start.isoformat(), end.isoformat()], "regions": regions}


def main(argv: list[str]) -> None:
    first, last = (int(argv[0]), int(argv[1])) if len(argv) == 2 else (2015, 2024)
    data = build(date(first, 1, 1), date(last, 12, 31))
    area_analysis.OUTLINES_PATH.write_text(json.dumps(data, separators=(",", ":")) + "\n", encoding="utf-8")
    print(f"{len(data['regions'])} regions written to {area_analysis.OUTLINES_PATH}", file=sys.stderr)


if __name__ == "__main__":
    main(sys.argv[1:])
