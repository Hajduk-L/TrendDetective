import unittest

import numpy as np

from correlation import CorrelationError, correlate


def _series(name, values, start=0):
    return {"name": name, "x": list(range(start, start + len(values))), "values": list(values)}


class CorrelateTests(unittest.TestCase):
    def test_identical_series_correlate_perfectly(self) -> None:
        rng = np.random.default_rng(1)
        v = rng.normal(size=200).tolist()
        pair = correlate([_series("a", v), _series("b", v)], max_lag=3)["pairs"][0]
        self.assertTrue(pair["available"])
        self.assertAlmostEqual(pair["pearson"], 1.0, places=6)
        self.assertAlmostEqual(pair["spearman"], 1.0, places=6)
        self.assertEqual(pair["best_lag"]["lag"], 0)

    def test_lead_is_found_at_positive_lag(self) -> None:
        # B repeats A three intervals later: A leads B by 3.
        rng = np.random.default_rng(2)
        a = rng.normal(size=300)
        b = np.concatenate([rng.normal(size=3), a[:-3]]) + rng.normal(scale=0.1, size=300)
        res = correlate([_series("a", a), _series("b", b)], max_lag=6)
        pair = res["pairs"][0]
        self.assertEqual(pair["best_lag"]["lag"], 3)
        self.assertGreater(pair["best_lag"]["r"], 0.9)
        self.assertEqual(len(pair["lags"]), 13)

    def test_series_are_matched_by_interval_index(self) -> None:
        a = {"name": "a", "x": [0, 1, 2, 3, 4, 5, 6], "values": [1, 2, 3, 4, 5, 6, 7]}
        b = {"name": "b", "x": [2, 3, 4, 5, 6, 7, 8], "values": [3, 4, 5, 6, 7, 99, 99]}
        pair = correlate([a, b], max_lag=0)["pairs"][0]
        self.assertEqual(pair["n"], 5)
        self.assertAlmostEqual(pair["pearson"], 1.0, places=6)

    def test_autocorrelation_widens_p_value(self) -> None:
        rng = np.random.default_rng(3)
        walk_a = np.cumsum(rng.normal(size=400))
        walk_b = np.cumsum(rng.normal(size=400))
        pair = correlate([_series("a", walk_a), _series("b", walk_b)], max_lag=0)["pairs"][0]
        self.assertLess(pair["effective_n"], pair["n"] / 5)
        self.assertGreaterEqual(pair["p_value"], pair["p_value_unadjusted"])

    def test_missing_values_and_too_few_pairs(self) -> None:
        pair = correlate([_series("a", [1, None, 3]), _series("b", [1, 2, 3])])["pairs"][0]
        self.assertFalse(pair["available"])
        self.assertIn("error", pair)

    def test_all_pairs_for_three_series(self) -> None:
        rng = np.random.default_rng(4)
        s = [_series(n, rng.normal(size=50)) for n in "abc"]
        pairs = correlate(s, max_lag=2)["pairs"]
        self.assertEqual([(p["a"], p["b"]) for p in pairs], [("a", "b"), ("a", "c"), ("b", "c")])

    def test_bad_input(self) -> None:
        with self.assertRaises(CorrelationError):
            correlate([_series("a", [1, 2, 3])])
        with self.assertRaises(CorrelationError):
            correlate([_series("a", [1]), _series("b", [1])], max_lag=999)
        with self.assertRaises(CorrelationError):
            correlate([{"name": "a", "x": [0.5], "values": [1]}, _series("b", [1])])


if __name__ == "__main__":
    unittest.main()
