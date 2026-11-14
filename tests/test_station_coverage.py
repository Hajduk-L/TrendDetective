"""Tests for station_coverage (when do the stations of a selection have data)."""

import unittest
from datetime import date

import station_coverage


def _station(first: date, last: date) -> dict:
    return {
        "id": f"S{first.year}",
        "name": "station",
        "first": first,
        "last": last,
        "years": set(range(first.year, last.year + 1)),
        "distance_km": 1.0,
    }


class TopicKeyTest(unittest.TestCase):
    def test_card_key_with_code_selects_only_that_code(self) -> None:
        key, _, codes = station_coverage._topic_and_codes("temperature · maximum (TMAX)")
        self.assertEqual((key, codes), ("temperature", ("TMAX",)))

    def test_plain_topic_keeps_all_codes(self) -> None:
        _, topic, codes = station_coverage._topic_and_codes("precipitation")
        self.assertEqual(codes, topic.data_types)

    def test_unknown_and_moving_topics_are_rejected(self) -> None:
        with self.assertRaises(station_coverage.CoverageError):
            station_coverage._topic_and_codes("atlantis")
        with self.assertRaises(station_coverage.CoverageError):
            station_coverage._topic_and_codes("marine_temperature")


class SuggestionTest(unittest.TestCase):
    def test_station_that_ended_suggests_its_last_thirty_years(self) -> None:
        stations = [_station(date(1918, 1, 1), date(2000, 6, 30))]
        self.assertEqual(
            station_coverage._suggest(stations, 1, 2000),
            (date(1971, 1, 1), date(2000, 6, 30)),
        )

    def test_region_needs_enough_stations_at_the_same_time(self) -> None:
        stations = [
            _station(date(1950, 1, 1), date(2020, 12, 31)),
            _station(date(1990, 1, 1), date(2020, 12, 31)),
            _station(date(2011, 1, 1), date(2020, 12, 31)),
        ]
        start, end = station_coverage._suggest(stations, 3, 2020)
        self.assertEqual((start.year, end.year), (2011, 2020))

    def test_too_few_stations_give_no_suggestion(self) -> None:
        self.assertIsNone(station_coverage._suggest([_station(date(2000, 1, 1), date(2020, 1, 1))], 3, 2020))

    def test_missing_area_is_rejected(self) -> None:
        with self.assertRaises(station_coverage.CoverageError):
            station_coverage.data_coverage(None, "temperature")


if __name__ == "__main__":
    unittest.main()
