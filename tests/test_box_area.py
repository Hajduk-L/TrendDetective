"""Tests for boxes drawn on the map (area_analysis.box_region, stations_in_box)."""

import unittest
from datetime import date
from unittest import mock

import area_analysis
from station_sources import Station


def box(west: float, south: float, east: float, north: float) -> dict:
    return {
        "type": "Feature",
        "bbox": [west, south, east, north],
        "properties": {"shape": "box", "selectionId": "area-001"},
        "geometry": {
            "type": "Polygon",
            "coordinates": [[[west, south], [east, south], [east, north], [west, north], [west, south]]],
        },
    }


class BoxRegionTest(unittest.TestCase):
    def test_box_becomes_a_region(self) -> None:
        region = area_analysis.region_for_area(box(-74.3, 40.5, -73.7, 41.0))
        self.assertEqual(region.id, area_analysis.BOX_REGION_ID)
        self.assertEqual(region.bbox, (-74.3, 40.5, -73.7, 41.0))
        self.assertIsNone(area_analysis.box_problem(region))
        self.assertNotIn("note", region.to_dict())

    def test_bbox_falls_back_to_the_ring(self) -> None:
        area = box(10, 47, 12, 49)
        del area["bbox"]
        self.assertEqual(area_analysis.box_region(area).bbox, (10, 47, 12, 49))

    def test_too_large_and_antimeridian_boxes_are_rejected(self) -> None:
        large = area_analysis.box_region(box(0, 0, 20, 20))
        self.assertIn("km²", area_analysis.box_problem(large))
        crossing = area_analysis.box_region(box(175, 50, -175, 55))
        self.assertIn("180°", area_analysis.box_problem(crossing))

    def test_box_area(self) -> None:
        # 1° × 1° at the equator is about 111 km × 111 km.
        self.assertAlmostEqual(area_analysis.box_area_km2((0, 0, 1, 1)), 12364, delta=50)

    def test_large_box_request_gives_error_cards(self) -> None:
        request = mock.Mock(
            topics={"temperature": True},
            tools={},
            timeintervall=(date(2015, 1, 1), date(2024, 12, 31)),
            interval_length=(1.0, "Year"),
        )
        result = area_analysis.process_region_request(request, area_analysis.box_region(box(0, 0, 20, 20)))
        self.assertIn("km²", result["topics"]["temperature"]["error"])


class StationsInBoxTest(unittest.TestCase):
    def setUp(self) -> None:
        area_analysis._box_cache.clear()

    def test_partial_stations_are_listed_with_their_span(self) -> None:
        start, end = date(2000, 1, 1), date(2019, 12, 31)
        full = Station(source="NOAA", id="A", name="Full", latitude=40.6, longitude=-74.0,
                       first_date=date(1990, 1, 1), last_date=date(2024, 1, 1), coverage=1.0)
        most = Station(source="NOAA", id="B", name="Most", latitude=40.7, longitude=-73.9,
                       first_date=date(2003, 1, 1), last_date=date(2024, 1, 1), coverage=0.85)
        part = Station(source="NOAA", id="C", name="Part", latitude=40.8, longitude=-73.8,
                       first_date=date(2015, 1, 1), last_date=date(2024, 1, 1), coverage=0.25)
        with mock.patch.object(area_analysis, "_find_stations", return_value=[full, most, part]) as find, \
                mock.patch.object(area_analysis, "_other_source_stations", return_value=([], {}, [])):
            result = area_analysis.stations_in_box((-74.3, 40.5, -73.7, 41.0), "temperature", start, end)
        self.assertEqual(find.call_args.kwargs["min_coverage"], 0.0)
        self.assertEqual((result["total"], result["complete"], result["partial"], result["usable"]), (3, 1, 2, 2))
        by_name = {s["name"]: s for s in result["stations"]}
        self.assertEqual((by_name["Part"]["from"], by_name["Part"]["to"]), ("2015-01-01", "2019-12-31"))
        self.assertFalse(by_name["Part"]["used"])
        self.assertTrue(by_name["Most"]["used"])
        self.assertEqual(result["stations"][0]["name"], "Full")

    def test_point_only_topics(self) -> None:
        result = area_analysis.stations_in_box(
            (-74.3, 40.5, -73.7, 41.0), "temperature_hourly", date(2020, 1, 1), date(2020, 12, 31)
        )
        self.assertTrue(result["point_only"])
        self.assertEqual(result["stations"], [])


if __name__ == "__main__":
    unittest.main()
