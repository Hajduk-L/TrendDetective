"""Write which variables every area region has data for (``data/region_variables.json``).

Clicking a region on the map shows its variables at once, without first
running an analysis: for every variable an area request can evaluate, the
stations are found exactly like an area request does
(:func:`area_analysis._gather_stations`) over a reference period, and the
count is stored when it reaches :data:`area_analysis.MIN_STATIONS`. Counts
are capped at :data:`area_analysis.MAX_STATIONS` (the most an area request uses).

Run again after changing :data:`area_analysis.REGIONS` or the variable list::

    .venv/bin/python region_variables.py            # 2015–2024
    .venv/bin/python region_variables.py 2005 2024  # another period
"""

from __future__ import annotations

import json
import sys
from concurrent.futures import ThreadPoolExecutor
from datetime import date

import area_analysis
import interface
import noaa_api


def station_count(region: area_analysis.Region, topic: str, start: date, end: date) -> tuple[int, bool]:
    """``(stations an area request for topic would use in region, whether a source failed)``."""
    try:
        stations, _, _, errors = area_analysis._gather_stations(
            noaa_api.NOAAClient(), region, topic, start, end
        )
    except Exception as error:  # one failing source must not stop the whole build
        print(f"  {region.id} {topic}: failed ({error})", file=sys.stderr)
        return 0, True
    print(f"  {region.id} {topic}: {len(stations)} stations {errors or ''}", file=sys.stderr)
    # Enough stations despite a failing source is still a sure "has data".
    return len(stations), bool(errors) and len(stations) < area_analysis.MIN_STATIONS


def build(start: date, end: date) -> dict:
    """``{"period": [...], "regions": {id: {topic: stations}}}`` for every region."""
    topics = interface.AppInterface().get_sorted_topics()
    jobs = [
        (region, topic)
        for region in area_analysis.REGIONS
        for topic in topics
        if area_analysis._area_capable(region, topic)
    ]
    results: dict[tuple[str, str], int] = {}
    # Timeouts are common (NOAA): failed jobs are retried with fewer requests at a time.
    for workers in (4, 2, 1):
        if not jobs:
            break
        with ThreadPoolExecutor(max_workers=workers) as pool:
            answers = list(pool.map(lambda job: station_count(job[0], job[1], start, end), jobs))
        failed = []
        for job, (count, error) in zip(jobs, answers):
            results[(job[0].id, job[1])] = count
            if error:
                failed.append(job)
        jobs = failed
    regions: dict[str, dict[str, int]] = {region.id: {} for region in area_analysis.REGIONS}
    for (region_id, topic), count in results.items():
        if count >= area_analysis.MIN_STATIONS:
            regions[region_id][topic] = count
    unchecked = sorted(f"{region.id}/{topic}" for region, topic in jobs)
    if unchecked:
        print(f"still failing, left out: {', '.join(unchecked)}", file=sys.stderr)
    return {"period": [start.isoformat(), end.isoformat()], "regions": regions, "unchecked": unchecked}


def main(argv: list[str]) -> None:
    first, last = (int(argv[0]), int(argv[1])) if len(argv) == 2 else (2015, 2024)
    data = build(date(first, 1, 1), date(last, 12, 31))
    area_analysis.VARIABLES_PATH.write_text(json.dumps(data, indent=1) + "\n", encoding="utf-8")
    print(f"{len(data['regions'])} regions written to {area_analysis.VARIABLES_PATH}", file=sys.stderr)


if __name__ == "__main__":
    main(sys.argv[1:])
