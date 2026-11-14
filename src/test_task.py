import unittest

import torch

from src.task import LinearRegression, mann_kendall_test


class MannKendallTests(unittest.TestCase):
    def test_detects_significant_increasing_and_decreasing_trends(self):
        increasing = mann_kendall_test([1, 2, 3, 4, 5], [1, 2, 3, 4, 5])
        decreasing = mann_kendall_test([1, 2, 3, 4, 5], [5, 4, 3, 2, 1])

        self.assertEqual(increasing.s_statistic, 10)
        self.assertEqual(increasing.trend, "increasing")
        self.assertLess(increasing.p_value, 0.05)
        self.assertEqual(decreasing.s_statistic, -10)
        self.assertEqual(decreasing.trend, "decreasing")
        self.assertLess(decreasing.p_value, 0.05)

    def test_corrects_variance_for_ties(self):
        result = mann_kendall_test([1, 2, 3, 4, 5], [1, 2, 2, 3, 3], alpha=0.1)

        self.assertEqual(result.s_statistic, 8)
        self.assertAlmostEqual(result.variance, 44 / 3)
        self.assertGreater(result.tau, 0)
        self.assertEqual(result.trend, "increasing")

    def test_all_equal_values_have_no_trend(self):
        result = mann_kendall_test([1, 2, 3, 4], [7, 7, 7, 7])

        self.assertEqual(result.s_statistic, 0)
        self.assertEqual(result.z_statistic, 0)
        self.assertEqual(result.p_value, 1)
        self.assertEqual(result.tau, 0)
        self.assertEqual(result.trend, "no significant trend")

    def test_orders_observations_by_time_and_validates_inputs(self):
        result = mann_kendall_test([3, 1, 2], [3, 1, 2], alpha=0.5)
        self.assertEqual(result.trend, "increasing")

        with self.assertRaisesRegex(ValueError, "unique"):
            mann_kendall_test([1, 1, 2], [1, 2, 3])
        with self.assertRaisesRegex(ValueError, "alpha"):
            mann_kendall_test([1, 2, 3], [1, 2, 3], alpha=1)


class TrendAnalysisTests(unittest.TestCase):
    def setUp(self):
        self.regression = LinearRegression()

    def test_reports_rate_and_significant_t_test(self):
        result = self.regression.analyze_trend(
            [0, 1, 2, 3, 4, 5],
            [1.0, 3.1, 4.9, 7.2, 8.8, 11.1],
        )

        self.assertAlmostEqual(result.slope, 2.0, places=1)
        self.assertGreater(result.t_statistic, 0)
        self.assertLess(result.p_value, 0.05)
        self.assertLess(result.confidence_interval[0], result.slope)
        self.assertGreater(result.confidence_interval[1], result.slope)
        self.assertEqual(result.observations, 6)

    def test_accepts_torch_time_series(self):
        result = self.regression.analyze_trend(
            torch.tensor([2000.0, 2001.0, 2002.0]),
            torch.tensor([5.0, 7.0, 9.0]),
        )

        self.assertEqual(result.slope, 2.0)
        self.assertLess(result.p_value, 0.05)

    def test_rejects_invalid_inputs(self):
        invalid_cases = [
            (([1, 2], [1, 2]), "At least three observations"),
            (([1, 2, 3], [2, 3]), "same number of observations"),
            (([1, 1, 1], [2, 3, 4]), "two distinct values"),
            (([1, 2, float("nan")], [2, 3, 4]), "finite numbers"),
            (([1, 2, 3], [2, 3, 4], 1.0), "confidence_level"),
        ]
        for args, message in invalid_cases:
            with self.subTest(message=message), self.assertRaisesRegex(ValueError, message):
                self.regression.analyze_trend(*args)


if __name__ == "__main__":
    unittest.main()
