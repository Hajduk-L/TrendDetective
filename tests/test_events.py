"""Notable events (events.py): records, unusual days and spells."""

import unittest
from datetime import date, timedelta

import numpy as np

import events


def _temperature_series() -> list[tuple[date, float]]:
    rng = np.random.default_rng(0)
    start = date(2010, 1, 1)
    points = []
    for i in range(3650):
        day = start + timedelta(days=i)
        value = 10 + 10 * np.sin(2 * np.pi * (i - 110) / 365.25) + rng.normal(0, 2)
        if date(2015, 7, 20) <= day <= date(2015, 7, 26):
            value += 9
        if day == date(2012, 2, 5):
            value -= 15
        points.append((day, float(value)))
    return points


class DetectEventsTest(unittest.TestCase):
    def test_heat_wave_and_cold_day_are_found(self) -> None:
        found = events.detect_events(_temperature_series(), "tmax", "°C")
        kinds = {e["kind"]: e for e in found}
        self.assertTrue(kinds["record_high"]["date"].startswith("2015-07-2"))
        self.assertEqual(kinds["record_low"]["date"], "2012-02-05")
        spell = kinds["warm_spell"]
        self.assertEqual((spell["date"], spell["end"]), ("2015-07-20", "2015-07-26"))
        self.assertLessEqual(len(found), events.MAX_EVENTS)

    def test_precipitation_only_has_high_events_ranked_by_amount(self) -> None:
        rng = np.random.default_rng(1)
        start = date(2010, 1, 1)
        rain = [(start + timedelta(days=i), max(0.0, rng.gamma(0.5, 4) - 1)) for i in range(2000)]
        rain[700] = (rain[700][0], 120.0)
        found = events.detect_events(rain, "prcp", "mm/day")
        self.assertEqual(found[0]["kind"], "record_high")
        self.assertEqual(found[0]["value"], 120.0)
        self.assertTrue(all(not e["kind"].startswith(("low", "record_low", "cold")) for e in found))

    def test_events_are_declustered(self) -> None:
        found = events.detect_events(_temperature_series(), "tmax", "°C")
        highs = sorted(date.fromisoformat(e["date"]) for e in found if e["kind"] == "high")
        for a, b in zip(highs, highs[1:]):
            self.assertGreaterEqual((b - a).days, events.DECLUSTER_DAYS)

    def test_short_or_flat_series_have_no_events(self) -> None:
        self.assertEqual(events.detect_events([(date(2020, 1, d), 1.0) for d in range(1, 20)]), [])
        self.assertEqual(events.detect_events([(date(2020, 1, d), float(d)) for d in range(1, 5)]), [])

    def test_monthly_records(self) -> None:
        records = [
            {"date": f"{y}-{m:02d}", "value": 5.0 + (20.0 if (y, m) == (2018, 7) else 0.0) + m, "unit": "°C"}
            for y in range(2010, 2020)
            for m in range(1, 13)
        ]
        found = events.events_for_records(records, "tavg", "°C")
        self.assertEqual(found[0]["date"], "2018-07-01")
        self.assertFalse(any(e["kind"].endswith("spell") for e in found))


if __name__ == "__main__":
    unittest.main()
