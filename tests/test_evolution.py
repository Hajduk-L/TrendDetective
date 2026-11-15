"""Change over time of a value per year (evolution.py and POST /api/evolution)."""

import json
import math
import threading
import unittest
from http.server import ThreadingHTTPServer
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import numpy as np

import app
import plot_analysis
from evolution import evolution


def _warming(start: int = 1961, end: int = 2024, per_year: float = 0.04, noise: float = 0.1, seed: int = 3):
    years = list(range(start, end + 1))
    rng = np.random.default_rng(seed)
    values = [8.0 + per_year * (y - start) + float(rng.normal(0, noise)) for y in years]
    return years, values


class TrendTest(unittest.TestCase):
    def test_known_linear_trend_is_recovered(self) -> None:
        years, values = _warming()
        result = evolution(years, values)
        trend = result["trend"]
        self.assertAlmostEqual(trend["slope"], 0.04, delta=0.003)
        self.assertAlmostEqual(trend["slope_per_decade"], 0.4, delta=0.03)
        self.assertAlmostEqual(trend["sen_slope"], 0.04, delta=0.003)
        self.assertTrue(trend["significant"])
        self.assertEqual(trend["mk_direction"], "increasing")
        self.assertTrue(trend["mk_significant"])
        self.assertLess(trend["ci_low"], 0.04)
        self.assertGreater(trend["ci_high"], 0.04)
        self.assertAlmostEqual(trend["total_change"], trend["slope"] * 63, places=3)
        self.assertEqual(trend["n_years"], 64)

        points = result["running"]["points"]
        self.assertEqual(len(points), 64 - 10 + 1)
        self.assertTrue(all(p["slope"] > 0 for p in points))
        self.assertAlmostEqual(float(np.median([p["slope"] for p in points])), 0.04, delta=0.01)
        self.assertEqual(points[0]["start"], 1961)
        self.assertEqual(points[0]["end"], 1970)
        self.assertEqual(points[0]["centre"], 1965.5)

        c = result["consistency"]
        self.assertEqual(c["running_positive"], c["running_total"])
        self.assertEqual(c["running_negative"], 0)
        self.assertGreater(c["running_significant_positive"], 0)
        self.assertEqual(c["years_compared"], 64)
        self.assertEqual(c["increases_vs_previous"] + c["decreases_vs_previous"], 63)

    def test_noise_without_trend_is_not_significant(self) -> None:
        rng = np.random.default_rng(7)
        years = list(range(1950, 2020))
        values = [10 + float(rng.normal(0, 0.5)) for _ in years]
        trend = evolution(years, values)["trend"]
        self.assertFalse(trend["significant"])
        self.assertFalse(trend["mk_significant"])
        self.assertGreater(trend["p_value"], 0.05)


class SeriesTest(unittest.TestCase):
    def test_gaps_in_years(self) -> None:
        years, values = _warming(1990, 2020)
        keep = [i for i, y in enumerate(years) if y not in (1995, 2001, 2002, 2003, 2009)]
        result = evolution([years[i] for i in keep], [values[i] for i in keep])
        by_year = {p["year"]: p for p in result["series"]}
        self.assertNotIn(1995, by_year)
        self.assertIsNone(by_year[1996]["change_from_previous"])
        self.assertIsNotNone(by_year[1997]["change_from_previous"])
        self.assertTrue(any("have no value" in note for note in result["notes"]))
        # 1999–2008 has 7 of 10 years (enough); 2000–2009 only 6 (skipped).
        starts = {p["start"] for p in result["running"]["points"]}
        self.assertIn(1999, starts)
        self.assertNotIn(2000, starts)
        for p in result["running"]["points"]:
            self.assertGreaterEqual(p["n"], 7)

    def test_missing_values_are_skipped(self) -> None:
        result = evolution(
            [2000, 2001, 2002, 2003, 2004, 2005],
            [1.0, None, float("nan"), 2.0, float("inf"), 3.0],
        )
        self.assertEqual([p["year"] for p in result["series"]], [2000, 2003, 2005])
        self.assertEqual(result["trend"]["n_years"], 3)
        json.dumps(result, allow_nan=False)

    def test_interval_only_with_n_and_sd(self) -> None:
        result = evolution(
            [2000, 2001, 2002, 2003],
            [1.0, 2.0, 3.0, 4.0],
            n=[31, None, 1, 31],
            sd=[2.0, 2.0, 2.0, None],
        )
        series = result["series"]
        margin = 2.0425 * 2.0 / math.sqrt(31)  # t(0.975, 30) = 2.0423
        self.assertAlmostEqual(series[0]["ci_low"], 1.0 - margin, places=2)
        self.assertAlmostEqual(series[0]["ci_high"], 1.0 + margin, places=2)
        for entry in series[1:]:
            self.assertIsNone(entry["ci_low"])
            self.assertIsNone(entry["ci_high"])
        plain = evolution([2000, 2001, 2002], [1.0, 2.0, 3.0])
        self.assertTrue(all(p["ci_low"] is None for p in plain["series"]))
        self.assertTrue(any("confidence intervals omitted" in n for n in plain["notes"]))

    def test_short_series_has_no_running_trends(self) -> None:
        result = evolution(list(range(2015, 2023)), [float(i) for i in range(8)])
        self.assertEqual(result["running"]["points"], [])
        self.assertEqual(result["running"]["window_years"], 10)
        self.assertEqual(result["consistency"]["running_total"], 0)
        self.assertTrue(any("running 10-year trends not computed" in n for n in result["notes"]))
        self.assertTrue(result["trend"]["available"])

    def test_single_value_has_no_trend(self) -> None:
        result = evolution([2020], [5.0])
        self.assertFalse(result["trend"]["available"])
        self.assertEqual(result["series"][0]["anomaly"], 0.0)

    def test_smaller_window(self) -> None:
        years, values = _warming(2000, 2020)
        result = evolution(years, values, window_years=5)
        self.assertEqual(len(result["running"]["points"]), 17)


class BaselineAndDecadeTest(unittest.TestCase):
    def test_default_baseline_is_first_years(self) -> None:
        years, values = _warming(1995, 2024)
        base = evolution(years, values)["baseline"]
        self.assertEqual(base["kind"], "first_years")
        self.assertEqual((base["start"], base["end"], base["years_used"]), (1995, 2004, 10))

    def test_wmo_normal_preferred_when_covered(self) -> None:
        years, values = _warming(1950, 2024)
        base = evolution(years, values)["baseline"]
        self.assertEqual((base["start"], base["end"], base["kind"]), (1961, 1990, "wmo_normal"))
        self.assertEqual(base["years_used"], 30)
        years, values = _warming(1985, 2024)
        base = evolution(years, values)["baseline"]
        self.assertEqual((base["start"], base["end"]), (1991, 2020))

    def test_baseline_override(self) -> None:
        years = list(range(2000, 2020))
        values = [float(y - 2000) for y in years]
        result = evolution(years, values, baseline=[2010, 2014])
        base = result["baseline"]
        self.assertEqual((base["start"], base["end"], base["kind"]), (2010, 2014, "custom"))
        self.assertEqual(base["mean"], 12.0)
        self.assertEqual(result["series"][0]["anomaly"], -12.0)
        self.assertEqual(result["consistency"]["years_above_baseline"], 7)

    def test_decades_are_calendar_decades(self) -> None:
        years = list(range(1978, 2004))
        values = [float(y // 10 * 10 - 1980) for y in years]  # 1980s: 0, 1990s: 10
        decades = evolution(years, values)["decades"]
        self.assertEqual([d["label"] for d in decades], ["1980s", "1990s"])  # 1970s and 2000s too short
        self.assertEqual((decades[0]["start"], decades[0]["end"], decades[0]["n"]), (1980, 1989, 10))
        self.assertEqual(decades[1]["diff_to_first"], 10.0)


class BadInputTest(unittest.TestCase):
    def test_bad_input_raises(self) -> None:
        cases = [
            ([2000, 2001], [1.0]),
            ([2000, 2000], [1.0, 2.0]),
            ([2000.5], [1.0]),
            ([True], [1.0]),
            (["x"], [1.0]),
            ([2000], ["a"]),
            ([2000], [None]),
            (list(range(3000)), [1.0] * 3000),
        ]
        for years, values in cases:
            with self.subTest(years=years[:3]), self.assertRaises(plot_analysis.AnalysisError):
                evolution(years, values)
        with self.assertRaises(plot_analysis.AnalysisError):
            evolution([2000, 2001], [1.0, 2.0], window_years=2)
        with self.assertRaises(plot_analysis.AnalysisError):
            evolution([2000, 2001], [1.0, 2.0], baseline=[1900, 1910])
        with self.assertRaises(plot_analysis.AnalysisError):
            evolution([2000, 2001], [1.0, 2.0], n=[1])
        with self.assertRaises(plot_analysis.AnalysisError):
            evolution([2000, 2001], [1.0, 2.0], sd=[-1, 1])


class EndpointTest(unittest.TestCase):
    def setUp(self) -> None:
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), app.WebAppHandler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        self.base = f"http://127.0.0.1:{self.server.server_address[1]}"

    def _post(self, body: bytes) -> dict:
        req = Request(self.base + "/api/evolution", data=body, headers={"Content-Type": "application/json"})
        with urlopen(req, timeout=10) as res:
            return json.loads(res.read())

    def test_round_trip(self) -> None:
        years, values = _warming(1980, 2020)
        values[3] = None
        data = self._post(json.dumps({
            "years": years,
            "values": values,
            "n": [365] * len(years),
            "sd": [3.0] * len(years),
            "window_years": 15,
            "baseline": [1981, 2010],
        }).encode())
        self.assertEqual(data["baseline"]["kind"], "custom")
        self.assertEqual(data["running"]["window_years"], 15)
        self.assertEqual(len(data["series"]), len(years) - 1)
        self.assertIsNotNone(data["series"][0]["ci_low"])
        self.assertGreater(data["trend"]["slope"], 0)

    def test_bad_input_is_a_json_400(self) -> None:
        for body in (b"[1, 2]", b"{not json", json.dumps({"years": [1], "values": [1, 2]}).encode()):
            with self.subTest(body=body), self.assertRaises(HTTPError) as ctx:
                self._post(body)
            self.assertEqual(ctx.exception.code, 400)
            self.assertIn("error", json.loads(ctx.exception.read()))
            ctx.exception.close()


if __name__ == "__main__":
    unittest.main()
