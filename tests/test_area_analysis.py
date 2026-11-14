"""Tests for area_analysis (evaluating a predefined region instead of a point)."""

import unittest

import area_analysis


class RegionLookupTest(unittest.TestCase):
    def test_region_selection_is_recognised(self) -> None:
        area = {"properties": {"shape": "region", "regionId": "bavaria"}}
        self.assertEqual(area_analysis.region_for_area(area).name, "Bavaria")

    def test_point_and_unknown_region_are_not_regions(self) -> None:
        self.assertIsNone(area_analysis.region_for_area(None))
        self.assertIsNone(area_analysis.region_for_area({"properties": {"shape": "point"}}))
        self.assertIsNone(
            area_analysis.region_for_area({"properties": {"shape": "region", "regionId": "atlantis"}})
        )

    def test_regions_are_valid_boxes_with_unique_ids(self) -> None:
        regions = area_analysis.list_regions()
        self.assertEqual(len({r["id"] for r in regions}), len(regions))
        for region in regions:
            west, south, east, north = region["bbox"]
            self.assertLess(west, east, region["id"])
            self.assertLess(south, north, region["id"])


class AreaSeriesTest(unittest.TestCase):
    def test_gap_in_a_warm_station_does_not_make_a_jump(self) -> None:
        # Two stations with the same trend at different levels; the warm one misses interval 1.
        stations = {
            "cold": {0: 0.0, 1: 1.0, 2: 2.0},
            "warm": {0: 10.0, 2: 12.0},
        }
        series = area_analysis._area_series(stations)
        self.assertEqual(list(series), [0, 1, 2])
        self.assertLess(series[0], series[1])
        self.assertLess(series[1], series[2])

    def test_empty_input_gives_empty_series(self) -> None:
        self.assertEqual(area_analysis._area_series({}), {})


if __name__ == "__main__":
    unittest.main()
