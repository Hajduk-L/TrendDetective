"""Tests for the progressive 'Apply' (one topic at a time, see AppInterface.iter_apply)."""

import unittest
from datetime import date
from unittest import mock

import area_analysis
import interface
import src.task as task

TOPICS = ["temperature", "precipitation", "snow"]


def _record(code: str, station: str, day: str, value: float) -> dict:
    return {
        "date": day,
        "value": value,
        "description": code,
        "unit": "°C",
        "station": station,
        "station_name": f"Station {station}",
        "latitude": 48.1,
        "longitude": 11.5,
        "elevation": 500,
        "source": "test",
    }


def _records(topic: str, *_args) -> list[dict]:
    if topic == "snow":
        raise RuntimeError("No station nearby reports snow.")
    days = [f"2020-01-{d:02d}" for d in range(1, 9)]
    if topic == "temperature":  # two codes: two result cards, one shared station
        return [_record(code, "S1", d, i + k) for k, code in enumerate(("TMAX", "TMIN")) for i, d in enumerate(days)]
    return [_record("PRCP", "S1", d, i * 0.5) for i, d in enumerate(days)]  # same station


def _make_interface(area=None) -> interface.AppInterface:
    app = interface.AppInterface()
    app.get_sorted_topics = lambda: list(TOPICS)  # type: ignore[method-assign]
    app.set_request_inputs(
        states={t: True for t in TOPICS},
        tools={"Linear Regression": True, "t-Test": True, "Mann-Kendall": True},
        timeintervall=("01.01.2020", "08.01.2020"),
        interval_length=(1.0, "Day"),
        area=area,
    )
    return app


class ProgressiveApplyTest(unittest.TestCase):
    def test_point_stream_ends_with_the_one_shot_result(self) -> None:
        with mock.patch.object(task, "_load_records_for_topic", side_effect=_records):
            app = _make_interface()
            app.on_apply()
            full = app.last_task_results
            steps = list(app.iter_apply(app.prepare_apply()))
        self.assertEqual([topic for topic, _ in steps], TOPICS)
        self.assertEqual(steps[-1][1], full)
        self.assertEqual(app.last_task_results, full)
        # One station dot listing the cards of both topics, as in the one-shot result.
        stations = [l for l in full["map_layers"] if l["id"] == "measuring-stations"][0]
        self.assertEqual(len(stations["data"]["features"]), 1)
        self.assertEqual(len(stations["data"]["features"][0]["properties"]["topics"]), 3)
        # The first step already holds the first topic's cards.
        self.assertTrue(all(k.startswith("temperature") for k in steps[0][1]["topics"]))

    def test_region_stream_ends_with_the_one_shot_result(self) -> None:
        def evaluate(client, region, topic, *_args):
            if topic == "snow":
                raise ValueError("No snow here.")
            station = {"type": "Feature", "geometry": {"type": "Point", "coordinates": [11, 48]},
                       "properties": {"topic": topic}}
            result = {"values": [1.0, 2.0], "mean": 1.5, "station_count": 3,
                      "tools": {"Linear Regression": {"slope": 1.0}}}
            return [(topic, result, [station])]

        area = {"properties": {"shape": "region", "regionId": "bavaria"}}
        with mock.patch.object(area_analysis, "_evaluate_topic", side_effect=evaluate):
            app = _make_interface(area)
            app.on_apply()
            full = app.last_task_results
            steps = list(app.iter_apply(app.prepare_apply()))
        self.assertEqual(steps[-1][1], full)

    def test_unexpected_failure_keeps_the_other_topics(self) -> None:
        def records(topic, *args):
            if topic == "precipitation":
                raise KeyError("boom")
            return _records(topic, *args)

        with mock.patch.object(task, "_load_records_for_topic", side_effect=records):
            app = _make_interface()
            steps = list(app.iter_apply(app.prepare_apply()))
        final = steps[-1][1]["topics"]
        self.assertIn("KeyError", final["precipitation"]["error"])
        self.assertTrue(any(k.startswith("temperature") and final[k]["values"] for k in final))
        self.assertIn("snow", final)


if __name__ == "__main__":
    unittest.main()
