from datetime import date
from types import SimpleNamespace
from unittest.mock import patch
import unittest

import torch

from src.task import LinearRegression, _load_records_for_topic, get_available_tools, mann_kendall_test, precipitation_as_density, process_user_request, split_by_variable


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


class RequestProcessingTests(unittest.TestCase):
    def test_all_analysis_tools_are_available(self):
        self.assertEqual(
            get_available_tools(),
            ["Linear Regression", "Mann-Kendall", "t-Test"],
        )

    @patch("src.task._load_records_for_topic")
    def test_request_returns_regression_ttest_and_mann_kendall(self, load_records):
        start_date = date(2024, 1, 1)
        load_records.return_value = [
            {"date": f"2024-01-0{day}", "value": float(day)}
            for day in range(1, 7)
        ]
        request = SimpleNamespace(
            topics={"temperature": True},
            tools={
                "Linear Regression": True,
                "t-Test": True,
                "Mann-Kendall": True,
            },
            timeintervall=(start_date, date(2024, 1, 6)),
            interval_length=(1.0, "Day"),
            area={"geometry": {"type": "Point", "coordinates": [-77.0, 38.9]}},
        )

        result = process_user_request(request)
        topic_result = result["topics"]["temperature"]

        self.assertEqual(topic_result["values"], [1, 2, 3, 4, 5, 6])
        self.assertEqual(topic_result["coordinates"], [38.9, -77.0])
        self.assertAlmostEqual(topic_result["tools"]["Linear Regression"]["slope"], 1.0)
        self.assertTrue(topic_result["tools"]["t-Test"]["available"])
        self.assertTrue(topic_result["tools"]["Mann-Kendall"]["available"])
        self.assertEqual(topic_result["tools"]["Mann-Kendall"]["trend"], "increasing")
        self.assertEqual(len(result["map_layers"]), 1)
        load_records.assert_called_once_with(
            "temperature", 38.9, -77.0, start_date, date(2024, 1, 6)
        )

    @patch("src.task._load_records_for_topic")
    def test_each_noaa_code_gets_its_own_series(self, load_records):
        load_records.return_value = [
            {"date": f"2024-01-0{day}", "value": value, "description": code, "unit": "°C"}
            for day in range(1, 5)
            for code, value in (("tmax", 10.0 + day), ("tmin", -5.0 - day), ("tavg", 2.0))
        ]
        request = SimpleNamespace(
            topics={"temperature": True},
            tools={"Linear Regression": True},
            timeintervall=(date(2024, 1, 1), date(2024, 1, 4)),
            interval_length=(1.0, "Day"),
            area={"geometry": {"type": "Point", "coordinates": [-77.0, 38.9]}},
        )

        topics = process_user_request(request)["topics"]

        self.assertEqual(
            sorted(topics),
            [
                "temperature · average (TAVG)",
                "temperature · maximum (TMAX)",
                "temperature · minimum (TMIN)",
            ],
        )
        minimum = topics["temperature · minimum (TMIN)"]
        self.assertEqual(minimum["values"], [-6, -7, -8, -9])
        self.assertEqual(minimum["variables"], ["tmin"])
        self.assertEqual(minimum["unit"], "°C")
        self.assertAlmostEqual(minimum["tools"]["Linear Regression"]["slope"], -1.0)
        self.assertEqual(topics["temperature · maximum (TMAX)"]["values"], [11, 12, 13, 14])

    def test_split_by_variable_keeps_single_variable_topics_unchanged(self):
        records = [{"date": "2024-01-01", "value": 1.0, "description": "prcp"}]
        self.assertEqual(split_by_variable("precipitation", records), [("precipitation", records)])

    @patch("src.task.api_wrapper.fetch_data_single_topic_single_coordinate")
    def test_noaa_loader_consumes_each_measurement_iterator(self, fetch_data):
        first = {"date": "2024-01-01", "value": 1.0}
        second = {"date": "2024-01-02", "value": 2.0}
        fetch_data.return_value = [iter([first]), iter([second])]

        records = _load_records_for_topic(
            "temperature", 38.9, -77.0, date(2024, 1, 1), date(2024, 1, 2)
        )

        # Only NOAA covers Washington; every record names its database.
        self.assertEqual(records, [{**first, "source": "NOAA"}, {**second, "source": "NOAA"}])
        fetch_data.assert_called_once()
        request = fetch_data.call_args.args[0]
        self.assertEqual(request.topic, "temperature")
        self.assertEqual(fetch_data.call_args.kwargs["provider"], "noaa")


class PrecipitationDensityTests(unittest.TestCase):
    def test_monthly_totals_and_rain_day_counts_become_per_day_values(self):
        # Real NANJING (CHM00058238) values for January 2020 (31 days).
        records = [
            {"date": "2020-01", "value": 75.9, "description": "prcp", "unit": "mm"},
            {"date": "2020-01", "value": 16, "description": "dp01", "unit": "days"},
            {"date": "2020-01", "value": 22.9, "description": "emxp", "unit": "mm"},
        ]
        prcp, dp01, emxp = precipitation_as_density(records)
        self.assertAlmostEqual(prcp["value"], 75.9 / 31, places=3)
        self.assertEqual(prcp["unit"], "mm/day")
        self.assertAlmostEqual(dp01["value"], 100 * 16 / 31, places=3)
        self.assertEqual(dp01["unit"], "% of days")
        self.assertEqual(emxp, records[2])  # a daily maximum is already per day

    def test_multiday_total_is_spread_over_its_dapr_days(self):
        records = [
            {"date": "2020-07-03", "value": 4.0, "description": "prcp", "unit": "mm", "station": "S"},
            {"date": "2020-07-05", "value": 30.0, "description": "mdpr", "unit": "mm", "station": "S"},
            {"date": "2020-07-05", "value": 3, "description": "dapr", "unit": None, "station": "S"},
        ]
        converted = precipitation_as_density(records)
        self.assertEqual([r["description"] for r in converted], ["prcp", "mdpr"])
        self.assertEqual(converted[0]["value"], 4.0)
        self.assertEqual(converted[0]["unit"], "mm/day")
        self.assertEqual(converted[1]["value"], 10.0)
        self.assertEqual(converted[1]["unit"], "mm/day")


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
