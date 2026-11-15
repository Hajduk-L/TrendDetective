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

    def test_regions_follow_the_selected_topics(self) -> None:
        all_ids = {r["id"] for r in area_analysis.list_regions()}
        temperature = area_analysis.list_regions(["temperature"])
        self.assertTrue(temperature)
        self.assertTrue(all("temperature" in r["note"] for r in temperature))
        # Hourly and marine data have no fixed area stations: no region offered.
        self.assertEqual(area_analysis.list_regions(["temperature_hourly"]), [])
        self.assertEqual(area_analysis.list_regions(["marine_waves"]), [])
        # A region with fewer than MIN_STATIONS counted stations is left out.
        sparse = area_analysis.Region("sparse", "Sparse", (0.0, 0.0, 1.0, 1.0), 1, 50)
        self.assertIsNone(area_analysis._region_for_topics(sparse, ["temperature"]))
        self.assertIsNotNone(area_analysis._region_for_topics(sparse, ["precipitation"]))
        self.assertLessEqual({r["id"] for r in temperature}, all_ids)


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


def _station(longitude: float, latitude: float) -> dict:
    return {"geometry": {"type": "Point", "coordinates": [longitude, latitude]}}


class StationHullTest(unittest.TestCase):
    def setUp(self) -> None:
        self.region = area_analysis.REGIONS[0]

    def test_convex_hull_drops_inner_points(self) -> None:
        square = [(0, 0), (2, 0), (2, 2), (0, 2)]
        self.assertEqual(sorted(area_analysis._convex_hull(square + [(1, 1), (1, 0)])), sorted(square))

    def test_hull_encloses_every_station_with_a_border(self) -> None:
        stations = [_station(11.0, 48.0), _station(12.0, 48.2), _station(11.5, 49.0), _station(11.5, 48.4)]
        ring = area_analysis._station_hull(stations, self.region)["coordinates"][0]
        self.assertEqual(ring[0], ring[-1])
        longitudes = [p[0] for p in ring]
        latitudes = [p[1] for p in ring]
        border = area_analysis.HULL_BORDER_KM / 111.32
        self.assertAlmostEqual(max(latitudes), 49.0 + border, places=3)
        self.assertAlmostEqual(min(latitudes), 48.0 - border, places=3)
        self.assertLess(min(longitudes), 11.0)
        self.assertGreater(max(longitudes), 12.0)

    def test_single_station_gives_a_circle_and_none_gives_the_box(self) -> None:
        ring = area_analysis._station_hull([_station(11.0, 48.0)], self.region)["coordinates"][0]
        self.assertEqual(len(ring), area_analysis._HULL_CIRCLE_POINTS + 1)
        west, south, east, north = self.region.bbox
        box = area_analysis._station_hull([], self.region)["coordinates"][0]
        self.assertEqual(box, [[west, south], [east, south], [east, north], [west, north], [west, south]])


class RegionOutlineTest(unittest.TestCase):
    """The map draws each region as the outline of its stations (data/region_outlines.json)."""

    def setUp(self) -> None:
        self.saved = area_analysis._outlines
        self.region = area_analysis.REGIONS[0]
        self.temperature = area_analysis.hull_polygon([(-77.0, 39.0), (-76.8, 39.2), (-77.2, 39.3)], self.region)
        self.precipitation = area_analysis.hull_polygon([(-77.4, 38.8), (-76.5, 39.5), (-77.0, 39.4)], self.region)
        area_analysis._outlines = {self.region.id: {"temperature": self.temperature, "precipitation": self.precipitation}}

    def tearDown(self) -> None:
        area_analysis._outlines = self.saved

    def _listed(self, topics: list[str] | None) -> dict:
        return next(r for r in area_analysis.list_regions(topics) if r["id"] == self.region.id)

    def test_outline_follows_the_selected_topic(self) -> None:
        self.assertEqual(self._listed(["precipitation"])["outline"], self.precipitation)
        self.assertEqual(self._listed(["temperature", "precipitation"])["outline"], self.temperature)
        self.assertEqual(self._listed(["precipitation"])["outline_topic"], "precipitation")

    def test_other_topics_and_no_topics_use_the_temperature_outline(self) -> None:
        self.assertEqual(self._listed(None)["outline"], self.temperature)
        self.assertEqual(self._listed(["snowfall"])["outline"], self.temperature)

    def test_regions_without_outline_keep_only_their_box(self) -> None:
        other = next(r for r in area_analysis.list_regions(None) if r["id"] != self.region.id)
        self.assertNotIn("outline", other)
        self.assertEqual(len(other["bbox"]), 4)

    def test_shipped_outlines_cover_every_region(self) -> None:
        area_analysis._outlines = None
        outlines = area_analysis.region_outlines()
        for region in area_analysis.REGIONS:
            ring = outlines[region.id]["temperature"]["coordinates"][0]
            self.assertEqual(ring[0], ring[-1])
            self.assertGreaterEqual(len(ring), 4)


if __name__ == "__main__":
    unittest.main()
