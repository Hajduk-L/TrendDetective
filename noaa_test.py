"""Run a fixed live NOAA NCEI integration request and print returned data.

The example requests daily temperature observations near Washington, DC,
from January through May 2020. It saves normalized NOAA observations under
``data/noaa_test/`` and prints up to ten returned records. The NCEI Access
Data Service does not require an API key.

Run from the repository root with::

    python noaa_test.py
"""

from __future__ import annotations

import json
import sys
from datetime import date
from itertools import islice
from pathlib import Path
from typing import Any, Iterator

from api_wrapper import PointDataRequest, fetch_data_single_topic_single_coordinate
from noaa_api import NOAAError


REQUEST: PointDataRequest = PointDataRequest(
    latitude=38.8951,
    longitude=-77.0364,
    topic="temperature",
    start_date=date(2020, 1, 1),
    end_date=date(2020, 5, 31),
)
"""Fixed integration request: temperature near Washington, DC, in early 2020."""

OUTPUT_DIR: Path = Path("data/noaa_test")
"""Directory for the saved NOAA response."""

MAX_PREVIEW_RECORDS: int = 10
"""Maximum number of records printed for each measurement collection."""


def display_data(
    collections: list[Iterator[dict[str, Any]]],
    *,
    max_records: int = MAX_PREVIEW_RECORDS,
) -> None:
    """Print a bounded preview of per-variable observation iterators.

    :param collections: Per-variable observation iterators from the API wrapper.
    :type collections: list[typing.Iterator[dict[str, typing.Any]]]
    :param max_records: Maximum number of observation records to print.
    :type max_records: int
    :returns: ``None``. Output is written to standard output.
    :rtype: None
    """
    print(f"\nReturned {len(collections)} measurement iterator(s):")
    collection: Iterator[dict[str, Any]]
    for index, collection in enumerate(collections, start=1):
        preview: list[dict[str, Any]] = list(islice(collection, max_records))
        if not preview:
            continue
        description: str = preview[0]["description"]
        print(
            f"\nCollection {index} ({description}); "
            f"showing up to {max_records} record(s):"
        )
        record: dict[str, Any]
        for record in preview:
            print(json.dumps(record, ensure_ascii=False, indent=2))


def run_noaa_test() -> None:
    """Fetch the fixed NOAA request and show its returned records.

    :returns: ``None``. Displays observations while consuming the iterators.
    :rtype: None
    :raises NOAAError: If the NOAA service rejects or fails the request.
    :raises ValueError: If the request parameters are invalid.
    """
    print("Submitting NOAA NCEI integration request:")
    print(
        f"  topic={REQUEST.topic}, coordinate=({REQUEST.latitude}, "
        f"{REQUEST.longitude}), dates={REQUEST.start_date} to {REQUEST.end_date}"
    )

    request_result = fetch_data_single_topic_single_coordinate(
                REQUEST,
                provider="noaa",
                output_dir=OUTPUT_DIR,
            )

    for value_type in request_result:
        print(list(value_type))
        for measurement in value_type:
            print(measurement)
       
    collections: list[Iterator[dict[str, Any]]] = (
        fetch_data_single_topic_single_coordinate(
            REQUEST,
            provider="noaa",
            output_dir=OUTPUT_DIR,
        )
    )
    print(f"Saved JSON response under {OUTPUT_DIR}/")
    display_data(collections)


def main() -> int:
    """Run the NOAA integration example as a command-line program.

    :returns: Process exit status (0 for success, 1 for request failure).
    :rtype: int
    """
    try:
        run_noaa_test()
    except (NOAAError, ValueError) as error:
        print(f"NOAA NCEI integration request failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
