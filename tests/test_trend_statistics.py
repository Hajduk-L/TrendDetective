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


class DeseasonalisedToolsTest(unittest.TestCase):
    def test_monthly_trend_is_found_despite_the_seasonal_cycle(self) -> None:
        rng = np.random.default_rng(3)
        months = np.arange(600)
        y = 9 + 9 * np.sin(2 * np.pi * (months - 3) / 12) + 0.004 * months + rng.normal(0, 1.6, 600)
        result = plot_analysis.run_tools(list(months), list(y), ["Linear Regression", "t-Test"], per_year=12)
        self.assertTrue(result["Linear Regression"]["significant"])
        self.assertTrue(result["Linear Regression"]["deseasonalised"])
        self.assertAlmostEqual(result["Linear Regression"]["slope_per_decade"], 0.48, delta=0.1)

    def test_partial_years_do_not_fake_a_trend(self) -> None:
        # Three years plus January to early October: the extra summer
        # pulls a plain regression up by about 9 per decade.
        days = np.arange(0, 365 * 3 + 280)
        y = 10 * np.sin(2 * np.pi * (days - 110) / 365.25) + np.random.default_rng(1).normal(0, 1, days.size)
        result = plot_analysis.run_tools(list(days), list(y), ["Linear Regression"], per_year=365.2425)
        raw_per_decade = np.polyfit(days, y, 1)[0] * 3652.425
        self.assertGreater(abs(raw_per_decade), 5.0)
        self.assertLess(abs(result["Linear Regression"]["slope_per_decade"]), 0.5)


class ServedFilesTest(unittest.TestCase):
    def test_only_page_and_static_are_public(self) -> None:
        import app

        for path in ("/", "/index.html", "/static/plots/plots.js"):
            self.assertTrue(app._is_public_path(path), path)
        for path in ("/app.py", "/.git/config", "/static/../app.py", "/static/%2e%2e/app.py", "/data/cache/x"):
            self.assertFalse(app._is_public_path(path), path)


class SparseVariablesTest(unittest.TestCase):
    def test_a_handful_of_secondary_values_is_hidden(self) -> None:
        main = [{"description": "snow", "value": 1.0}] * 300
        rare = [{"description": "mdsf", "value": 5.0}] * 2
        groups = task.split_by_variable("snowfall", main + rare)
        kept = task.drop_sparse_variables(groups)
        self.assertEqual([key for key, _ in kept], ["snowfall · snowfall (SNOW)"])

    def test_balanced_variables_are_kept(self) -> None:
        records = [{"description": c, "value": 1.0} for c in ("tmax", "tmin") for _ in range(8)]
        self.assertEqual(len(task.drop_sparse_variables(task.split_by_variable("temperature", records))), 2)


class MarineCleaningTest(unittest.TestCase):
    def test_codes_dropped_visibility_decoded_buoy_thinned(self) -> None:
        import noaa_api

        def rec(code, value, station="B1", when="2020-01-06T01:00:00"):
            return {"description": code, "value": value, "station": station, "date": when, "unit": None}

        collections = [
            [rec("wind_dir", 330), rec("wind_dir", 361, when="2020-01-06T02:00:00")],
            [rec("visibility", 97), rec("visibility", 3, when="2020-01-06T02:00:00")],
            [rec("sea_surf_temp", 14.4), rec("sea_surf_temp", 14.5, when="2020-01-06T01:10:00"),
             rec("sea_surf_temp", 14.6, station="S2", when="2020-01-06T01:10:00")],
        ]
        wind, visibility, sst = noaa_api._clean_marine_rows(collections)
        self.assertEqual([r["value"] for r in wind], [330])
        self.assertEqual([(r["value"], r["unit"]) for r in visibility], [(10.0, "km")])
        self.assertEqual([(r["station"], r["value"]) for r in sst], [("B1", 14.4), ("S2", 14.6)])

    def test_long_marine_range_is_refused_clearly(self) -> None:
        import noaa_api

        request = PointDataRequest(42.3, -70.5, "marine_temperature", date(1990, 1, 1), date(2020, 12, 31))
        with self.assertRaisesRegex(ValueError, "ERA5"):
            noaa_api.NOAAClient()._fetch_marine_months(
                request, {"dataset": "global-marine", "dataTypes": "AIR_TEMP", "boundingBox": "1,2,3,4"}
            )


class AreaSeriesTest(unittest.TestCase):
    def test_stations_entering_and_leaving_keep_the_trend(self) -> None:
        import area_analysis

        trend = 0.005 * np.arange(100)
        offsets = [-3.0, 0.5, 2.0, -1.0, 4.0, 1.5]
        bins = {
            f"s{i}": {t: offsets[i] + trend[t] for t in (range(0, 80) if i < 3 else range(20, 100))}
            for i in range(6)
        }
        area = area_analysis._area_series(bins)
        slope = np.polyfit(list(area), list(area.values()), 1)[0]
        self.assertAlmostEqual(slope, 0.005, places=4)


class CalendarBinningTest(unittest.TestCase):
    def test_months_follow_the_calendar_and_partial_edges_are_dropped(self) -> None:
        records = [
            {"date": (date(2020, 1, 15) + __import__("datetime").timedelta(days=i)).isoformat(), "value": 1.0}
            for i in range(0, 120)
        ]
        stats: dict = {}
        indices, labels, values = task.bin_records_indexed(
            records, date(2020, 1, 15), date(2020, 5, 13), (1, "Month"), stats
        )
        # January (17 days) and May (13 days) are partial; Feb-Apr are complete calendar months.
        self.assertEqual(labels, ["01.02.2020", "01.03.2020", "01.04.2020"])
        self.assertEqual(indices, [1, 2, 3])
        self.assertEqual(stats["dropped"], 2)

    def test_monthly_values_never_share_a_bin(self) -> None:
        records = [{"date": f"2001-{m:02d}", "value": float(m)} for m in range(1, 13)]
        _, labels, values = task.bin_records_indexed(records, date(2001, 1, 15), date(2001, 12, 31), (1, "Month"))
        self.assertEqual(values, [float(m) for m in range(2, 13)])  # January starts before the range
        self.assertEqual(labels[0], "01.02.2001")

    def test_partial_last_year_is_left_out(self) -> None:
        records = [{"date": f"{y}", "value": 10.0} for y in range(2016, 2026)]
        records += [{"date": f"2026-0{m}-15", "value": 2.0} for m in (1, 2, 3)]
        _, labels, _ = task.bin_records_indexed(records, date(2016, 1, 1), date(2026, 3, 31), (1, "Year"))
        self.assertEqual(labels[-1], "01.01.2025")


class DirectionAndValidationTest(unittest.TestCase):
    def test_wind_direction_is_averaged_on_the_circle_without_trend_tools(self) -> None:
        records = [{"date": "2020-01-01", "value": v, "description": "wdf2"} for v in (350, 10)]
        _, _, values = task.bin_records_indexed(records, date(2020, 1, 1), date(2020, 1, 1), (1, "Day"))
        self.assertEqual(values, [0.0])
        tools = task.run_series_tools([0, 1, 2], [1.0, 2.0, 3.0], ["Linear Regression"], (1, "Day"), direction=True)
        self.assertFalse(tools["Linear Regression"]["available"])

    def test_request_validation(self) -> None:
        import interface

        app_interface = interface.AppInterface()
        app_interface.get_sorted_topics = lambda: ["temperature"]
        for timeintervall, interval in [
            (("01.01.1500", "31.12.2000"), (1, "Day")),
            (("01.01.2020", "31.12.2021"), (1e-320, "Day")),
            (("01.01.2020", "31.12.2021"), (5, "Year")),
            (("01.01.2020", "31.12.2021"), (1, "Week")),
        ]:
            with self.assertRaises(ValueError):
                app_interface.set_request_inputs({"temperature": True}, {}, timeintervall, interval)
        app_interface.set_request_inputs({"temperature": True}, {}, ("01.01.2020", "31.12.2999"), (1, "Day"))
        self.assertEqual(app_interface.timeintervall[1], date.today())

    def test_json_never_contains_nan(self) -> None:
        import app

        self.assertEqual(app.to_json({"a": float("nan"), "b": [float("inf"), 1]}), '{"a": null, "b": [null, 1]}')

    def test_fast_mann_kendall_s_is_exact(self) -> None:
        y = np.round(np.random.default_rng(2).normal(0, 3, 4000), 1)
        exact = sum(int(np.sign(y[i + 1 :] - y[i]).sum()) for i in range(len(y) - 1))
        self.assertEqual(task._mann_kendall_s(y), exact)
