"""Statistics added or fixed on the feature branch (src/task.py, plot_analysis.py, noaa_api.py)."""

import math
import unittest
from datetime import date

import numpy as np
import torch

import plot_analysis
from api_wrapper import PointDataRequest
from noaa_api import NOAAClient
from src import task

TOOLS = ["Linear Regression", "Mann-Kendall", "Sen's Slope", "Change Point", "t-Test"]


def _seasonal_ar1(trend_per_day: float = 0.0, n: int = 3653, seed: int = 1) -> np.ndarray:
    rng = np.random.default_rng(seed)
    noise = np.zeros(n)
    for i in range(1, n):
        noise[i] = 0.75 * noise[i - 1] + rng.normal(0, 2)
    days = np.arange(n)
    return 15 + 9 * np.sin(2 * np.pi * (days - 110) / 365.25) + noise + trend_per_day * days


class LinearRegressionPrecisionTest(unittest.TestCase):
    def test_long_series_fit_matches_numpy(self) -> None:
        y = _seasonal_ar1()
        slope, intercept = task.LinearRegression().process(
            torch.arange(len(y), dtype=torch.float32), torch.tensor(y, dtype=torch.float32)
        )
        expected_slope, expected_intercept = np.polyfit(np.arange(len(y)), y, 1)
        self.assertAlmostEqual(float(slope[0]), expected_slope, places=5)
        self.assertAlmostEqual(float(intercept[0]), expected_intercept, places=2)


class AutocorrelationTest(unittest.TestCase):
    def test_no_false_trend_in_autocorrelated_seasonal_noise(self) -> None:
        y = _seasonal_ar1()
        results = plot_analysis.run_tools(list(range(len(y))), list(y), TOOLS, per_year=365.2425)
        for name in TOOLS:
            self.assertFalse(results[name]["significant"], name)
        # The plain tests would have called it significant.
        self.assertLess(results["Linear Regression"]["p_value_unadjusted"], 0.05)
        self.assertLess(results["Mann-Kendall"]["p_value_unadjusted"], 0.05)

    def test_real_trend_is_still_found(self) -> None:
        y = _seasonal_ar1(trend_per_day=0.0008)
        results = plot_analysis.run_tools(list(range(len(y))), list(y), TOOLS[:3], per_year=365.2425)
        for name in TOOLS[:3]:
            self.assertTrue(results[name]["significant"], name)
        self.assertAlmostEqual(results["Linear Regression"]["slope_per_decade"], 0.0008 * 3652.425, delta=1.2)

    def test_effective_sample_size(self) -> None:
        self.assertEqual(task.effective_sample_size(100, 0.0), 100)
        self.assertAlmostEqual(task.effective_sample_size(100, 0.5), 100 / 3)
        self.assertEqual(task.effective_sample_size(100, -0.4), 100)


class SensSlopeTest(unittest.TestCase):
    def test_outlier_does_not_move_sens_slope(self) -> None:
        x = list(range(30))
        y = [0.5 * v for v in x]
        y[29] = 500.0
        result = plot_analysis.run_tools(x, y, ["Sen's Slope", "Linear Regression"])
        self.assertAlmostEqual(result["Sen's Slope"]["slope"], 0.5, places=6)
        self.assertGreater(result["Linear Regression"]["slope"], 3)

    def test_sampled_long_series_is_close_to_exact(self) -> None:
        rng = np.random.default_rng(3)
        x = np.arange(4000, dtype=float)
        y = 0.01 * x + rng.normal(0, 3, x.size)
        result = task.theil_sen(x, y)
        self.assertFalse(result.exact)
        self.assertAlmostEqual(result.slope, 0.01, delta=0.001)
        self.assertLess(result.low_slope, 0.01)
        self.assertGreater(result.high_slope, 0.01)


class ChangePointTest(unittest.TestCase):
    def test_finds_the_shift(self) -> None:
        rng = np.random.default_rng(5)
        y = np.concatenate([rng.normal(0, 1, 60), rng.normal(3, 1, 60)])
        result = plot_analysis.run_tools(list(range(120)), list(y), ["Change Point"], per_year=12,
                                         labels=[f"01.{1 + i % 12:02d}.{2000 + i // 12}" for i in range(120)])
        change = result["Change Point"]
        self.assertTrue(change["significant"])
        self.assertIn(change["x_after"], range(57, 64))
        self.assertGreater(change["shift"], 2)
        self.assertIn("date", change)

    def test_seasonal_cycle_alone_is_no_change_point(self) -> None:
        months = np.arange(120)
        y = 10 * np.sin(2 * np.pi * months / 12) + np.random.default_rng(2).normal(0, 1, 120)
        result = plot_analysis.run_tools(list(months), list(y), ["Change Point"], per_year=12)
        self.assertFalse(result["Change Point"]["significant"])


class MannKendallSpeedTest(unittest.TestCase):
    def test_vectorised_s_matches_definition(self) -> None:
        rng = np.random.default_rng(4)
        y = rng.normal(size=200)
        expected = sum(np.sign(y[j] - y[i]) for i in range(199) for j in range(i + 1, 200))
        self.assertEqual(task.mann_kendall_test(list(range(200)), list(y)).s_statistic, int(expected))


class GapAwareBinningTest(unittest.TestCase):
    def test_indices_keep_gaps(self) -> None:
        records = [{"date": d, "value": v} for d, v in [("2020-01-01", 1), ("2020-01-02", 2), ("2020-01-10", 10)]]
        indices, labels, values = task.bin_records_indexed(records, date(2020, 1, 1), date(2020, 1, 10), (1, "Day"))
        self.assertEqual(indices, [0, 1, 9])
        self.assertEqual(values, [1, 2, 10])
        tools = task.run_series_tools(indices, values, ["Linear Regression"], (1, "Day"), labels)
        self.assertAlmostEqual(tools["Linear Regression"]["slope"], 1.0, places=4)
        self.assertTrue(math.isclose(tools["Linear Regression"]["slope_per_year"], 365.2425, rel_tol=1e-3))


class StationRankingTest(unittest.TestCase):
    def _result(self, station: str, first: str, last: str, lon: float, types: list[str]) -> dict:
        return {
            "startDate": f"{first}T00:00:00",
            "endDate": f"{last}T00:00:00",
            "boundingPoints": [{"coordinates": [lon, 29.76]}],
            "stations": [{"id": station, "dataTypes": [{"id": t} for t in types]}],
        }

    def test_long_record_beats_nearer_short_gauge_with_more_codes(self) -> None:
        request = PointDataRequest(29.76, -95.37, "precipitation", date(2008, 1, 1), date(2017, 12, 31))
        payload = {"results": [
            self._result("SHORT", "2014-01-01", "2014-12-31", -95.371, ["PRCP", "MDPR", "DAPR"]),
            self._result("LONG", "1990-01-01", "2020-12-31", -95.40, ["PRCP"]),
        ]}
        ranked = NOAAClient._rank_stations(payload, request=request, requested_types=("PRCP", "MDPR", "DAPR"))
        self.assertEqual([station for station, _ in ranked], ["LONG", "SHORT"])


if __name__ == "__main__":
    unittest.main()
