"""Tests for plot_analysis (analysis tools on a series chosen in the plot panel)."""

import unittest

import plot_analysis


class AnalyzeSeriesTest(unittest.TestCase):
    def test_rising_series_has_positive_slope(self) -> None:
        years = list(range(2010, 2020))
        values = [0.3 * (y - 2010) + (0.1 if y % 2 else -0.1) for y in years]
        result = plot_analysis.analyze_series(years, values)
        lr = result["tools"]["Linear Regression"]
        self.assertTrue(lr["available"])
        self.assertAlmostEqual(lr["slope"], 0.3, places=1)
        self.assertTrue(lr["significant"])
        self.assertEqual(len(lr["trend_line"]), len(years))
        self.assertEqual(result["tools"]["Mann-Kendall"]["trend"], "increasing")
        self.assertGreater(result["tools"]["t-Test"]["late_mean"], result["tools"]["t-Test"]["early_mean"])

    def test_missing_values_are_dropped(self) -> None:
        result = plot_analysis.analyze_series([1, 2, 3, 4], [1.0, None, 2.0, 3.0], ["Linear Regression"])
        self.assertEqual(result["observations"], 3)
        self.assertEqual(list(result["tools"]), ["Linear Regression"])

    def test_short_series_reports_unavailable(self) -> None:
        result = plot_analysis.analyze_series([2020, 2021], [1.0, 2.0])
        for name in ("Linear Regression", "t-Test", "Mann-Kendall"):
            self.assertFalse(result["tools"][name]["available"], name)

    def test_bad_input_raises(self) -> None:
        with self.assertRaises(plot_analysis.AnalysisError):
            plot_analysis.analyze_series([1, 2], [1.0])
        with self.assertRaises(plot_analysis.AnalysisError):
            plot_analysis.analyze_series([1, 2], ["a", 2.0])
        with self.assertRaises(plot_analysis.AnalysisError):
            plot_analysis.analyze_series([1, 2, 3], [1, 2, 3], ["Fourier"])



class AnalyzeGroupsTest(unittest.TestCase):
    def test_each_group_gets_its_own_regression(self) -> None:
        days = list(range(31))
        groups = [
            {"key": 2020, "x": days, "values": [0.1 * d for d in days]},
            {"key": 2021, "x": days, "values": [5 - 0.2 * d for d in days]},
        ]
        result = plot_analysis.analyze_groups(groups, ["Linear Regression"])
        self.assertEqual([g["key"] for g in result["groups"]], [2020, 2021])
        self.assertAlmostEqual(result["groups"][0]["tools"]["Linear Regression"]["slope"], 0.1, places=3)
        self.assertAlmostEqual(result["groups"][1]["tools"]["Linear Regression"]["slope"], -0.2, places=3)

    def test_short_group_is_reported_not_raised(self) -> None:
        result = plot_analysis.analyze_groups([{"key": 1, "x": [0], "values": [1.0]}], ["Linear Regression"])
        self.assertFalse(result["groups"][0]["tools"]["Linear Regression"]["available"])

    def test_groups_must_be_a_list(self) -> None:
        with self.assertRaises(plot_analysis.AnalysisError):
            plot_analysis.analyze_groups({"x": []})


if __name__ == "__main__":
    unittest.main()
