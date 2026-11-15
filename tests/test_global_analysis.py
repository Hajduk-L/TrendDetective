"""Tests for the Global Explorer analysis on a small synthetic grid with known trends."""

from __future__ import annotations

import io
import json
import math
import unittest

import numpy as np

import global_analysis as ga
import global_api
import global_data as gd


def make_dataset(first=1900, last_year=1999, last_month=12, slope_per_year=0.02, noise=0.1,
                 seed=1, lat_step=20.0, lon_step=45.0, ar1=0.0) -> gd.GriddedDataset:
    """Grid whose cells warm with ``slope_per_year`` × (1 + row index); NaN in one cell."""
    lats = np.arange(-90 + lat_step / 2, 90, lat_step)
    lons = np.arange(-180 + lon_step / 2, 180, lon_step)
    years, months = [], []
    for y in range(first, last_year + 1):
        for m in range(1, 13):
            if y == last_year and m > last_month:
                break
            years.append(y)
            months.append(m)
    years = np.array(years)
    months = np.array(months)
    rng = np.random.default_rng(seed)
    t = years + (months - 0.5) / 12
    factor = (1 + np.arange(lats.size))[None, :, None]
    eps = rng.normal(0, noise, (t.size, lats.size, lons.size))
    if ar1:
        for i in range(1, t.size):
            eps[i] += ar1 * eps[i - 1]
    values = (slope_per_year * factor * (t - 1950)[:, None, None] + eps).astype(np.float32)
    values[:, 0, 0] = np.nan  # a cell without any data
    return gd.GriddedDataset(
        key="test", name="Synthetic", variable="T", unit="°C", baseline=(1951, 1980),
        citation="", url="", lats=lats, lons=lons, years=years, months=months, values=values,
    )


class OlsTrendTest(unittest.TestCase):
    def test_recovers_known_slope_and_significance(self):
        rng = np.random.default_rng(0)
        x = np.arange(1950, 2020, dtype=float)
        y = 0.03 * (x - 1950) + rng.normal(0, 0.1, x.size)
        fit = ga.ols_trend(x, y[:, None])
        self.assertAlmostEqual(float(fit["slope"][0]), 0.03, delta=0.003)
        self.assertLess(float(fit["p"][0]), 1e-6)

    def test_no_trend_is_not_significant(self):
        rng = np.random.default_rng(5)
        x = np.arange(1950, 2020, dtype=float)
        ys = rng.normal(0, 1, (x.size, 400))
        fit = ga.ols_trend(x, ys)
        false_positive = float(np.mean(fit["p"] < 0.05))
        self.assertLess(false_positive, 0.10)  # nominal 5 %

    def test_autocorrelation_widens_interval(self):
        rng = np.random.default_rng(3)
        x = np.arange(1900, 2000, dtype=float)
        e = np.zeros(x.size)
        for i in range(1, x.size):
            e[i] = 0.8 * e[i - 1] + rng.normal(0, 0.1)
        fit = ga.ols_trend(x, e[:, None])
        naive_se = math.sqrt(np.sum((e - np.polyval(np.polyfit(x, e, 1), x)) ** 2) / (x.size - 2)
                             / np.sum((x - x.mean()) ** 2))
        self.assertGreater(float(fit["r1"][0]), 0.4)
        self.assertGreater(float(fit["se"][0]), 1.5 * naive_se)

    def test_gaps_and_missing_thirds(self):
        x = np.arange(2000, 2030, dtype=float)
        y = x * 0.01
        y_gap = y.copy()
        y_gap[:10] = np.nan  # whole first third missing → no trend
        fit = ga.ols_trend(x, np.stack([y, y_gap], axis=1))
        self.assertTrue(math.isfinite(float(fit["slope"][0])))
        self.assertTrue(math.isnan(float(fit["slope"][1])))


class SeasonTest(unittest.TestCase):
    def setUp(self):
        ga.clear_cache()

    def test_incomplete_last_year_is_dropped_for_annual(self):
        ds = make_dataset(last_year=2000, last_month=10)
        years, _ = ga.seasonal_grid(ds, "annual")
        self.assertEqual(int(years[-1]), 1999)
        years_jja, _ = ga.seasonal_grid(ds, "JJA")
        self.assertEqual(int(years_jja[-1]), 2000)
        years_djf, _ = ga.seasonal_grid(ds, "DJF")
        self.assertEqual(int(years_djf[0]), 1901)  # the first winter has no December
        self.assertEqual(int(years_djf[-1]), 2000)

    def test_winter_uses_previous_december(self):
        ds = make_dataset(noise=0.0, slope_per_year=0.0)
        ds.values[:] = 0
        ds.values[(ds.years == 1950) & (ds.months == 12)] = 3.0
        years, grid = ga.seasonal_grid(ds, "DJF")
        i = int(np.nonzero(years == 1951)[0][0])
        self.assertAlmostEqual(float(grid[i, 1, 1]), 1.0, places=5)

    def test_baseline_shifts_level_not_trend(self):
        ds = make_dataset()
        t_native = ga.layer(ds, "trend", 1950, 1999)["values"]
        t_other = ga.layer(ds, "trend", 1950, 1999, baseline="1961-1990")["values"]
        for a, b in zip(t_native, t_other):
            if a is not None and b is not None:
                self.assertAlmostEqual(a, b, places=2)
        years, grid = ga.seasonal_grid(ds, "annual", "1961-1990")
        sel = (years >= 1961) & (years <= 1990)
        self.assertAlmostEqual(float(np.nanmean(grid[sel, 2, 3])), 0.0, places=4)


class RegionTest(unittest.TestCase):
    def setUp(self):
        ga.clear_cache()
        self.ds = make_dataset()

    def test_presets_are_valid(self):
        for region in ga.PRESET_REGIONS:
            ring = region.outline()
            self.assertGreaterEqual(len(ring), 4, region.id)
            for lon, lat in ring:
                self.assertIsInstance(lon, (int, float), region.id)
                self.assertTrue(-90 <= lat <= 90, region.id)
            weights = ga.region_weights(self.ds, region)
            self.assertGreater(weights.sum(), 0, region.id)

    def test_region_rejects_note_as_polygon(self):
        with self.assertRaises(ValueError):
            ga.Region("x", "X", "G", (0, 0, 1, 1), "a note in the wrong place")  # type: ignore[arg-type]

    def test_bbox_overlap_fraction(self):
        region = ga.parse_region({"bbox": [-180, 10, -157.5, 30]})  # half a 45° cell, one 20° row
        w = ga.region_weights(self.ds, region)
        row = int(np.argmin(np.abs(self.ds.lats - 20)))
        self.assertEqual(int(np.count_nonzero(w)), 1)
        self.assertAlmostEqual(float(w[row, 0]), 0.5 * math.cos(math.radians(20)), places=6)

    def test_dateline_box(self):
        region = ga.parse_region({"bbox": [170, -10, -170, 10]})
        w = ga.region_weights(self.ds, region)
        cols = sorted(set(np.nonzero(w)[1].tolist()))
        self.assertEqual(cols, [0, self.ds.lons.size - 1])

    def test_point_is_one_cell(self):
        for lon, lat in [(10, 50), (10, 51), (-180, -90), (179.9, 89.9)]:  # 50° is a cell edge
            w = ga.region_weights(self.ds, ga.parse_region({"point": [lon, lat]}))
            self.assertEqual(int(np.count_nonzero(w)), 1, (lon, lat))

    def test_polygon(self):
        region = ga.parse_region({"polygon": [[0, 0], [90, 0], [90, 40], [0, 40]]})
        w = ga.region_weights(self.ds, region)
        self.assertGreater(int(np.count_nonzero(w)), 0)

    def test_region_trend_matches_construction(self):
        row = 6  # factor 7 → 0.14 °C/yr
        lat = float(self.ds.lats[row])
        lon = float(self.ds.lons[3])
        out = ga.region_series(self.ds, [ga.parse_region({"point": [lon, lat]})], 1950, 1999)
        stats = out["regions"][0]["stats"]
        self.assertAlmostEqual(stats["trend"], 0.02 * 7 * 10, delta=0.02)
        self.assertLess(stats["trend_p"], 0.001)
        self.assertAlmostEqual(stats["sen"], stats["trend"], delta=0.03)
        self.assertGreater(stats["vs_global"], 1.0)
        self.assertEqual(len(out["regions"][0]["monthly_trends"]), 12)

    def test_empty_cell_gives_no_values(self):
        lat, lon = float(self.ds.lats[0]), float(self.ds.lons[0])
        out = ga.region_series(self.ds, [ga.parse_region({"point": [lon, lat]})], 1950, 1999)
        self.assertTrue(all(v is None for v in out["regions"][0]["values"]))
        self.assertIn("error", out["regions"][0]["stats"])

    def test_bad_input(self):
        for spec in [{"bbox": [0, 10, 5, 5]}, {"preset": "nope"}, {"polygon": [[0, 0]]}, 42, {"point": ["a", 1]}]:
            with self.assertRaises(ga.AnalysisInputError):
                ga.parse_region(spec)
        with self.assertRaises(ga.AnalysisInputError):
            ga.layer(self.ds, "trend", 1990, 1995)  # shorter than 10 years


class LayerTest(unittest.TestCase):
    def setUp(self):
        ga.clear_cache()
        self.ds = make_dataset()

    def test_all_layers(self):
        n = self.ds.lats.size * self.ds.lons.size
        for kind in ga.LAYERS:
            out = ga.layer(self.ds, kind, 1950, 1999)
            self.assertEqual(len(out["values"]), n, kind)
            self.assertIsNone(out["values"][0], kind)  # the empty cell stays empty
            json.dumps(out)
        trend = ga.layer(self.ds, "trend", 1950, 1999)
        self.assertAlmostEqual(trend["values"][self.ds.lons.size * 2 + 1], 0.02 * 3 * 10, delta=0.02)
        self.assertGreater(trend["summary"]["significant_area"], 0.9)

    def test_frames_roundtrip(self):
        years, payload = ga.frames(self.ds)
        arr = np.frombuffer(payload, dtype="<i2").reshape(len(years), self.ds.lats.size, self.ds.lons.size)
        self.assertEqual(int(arr[0, 0, 0]), -32768)
        _, grid = ga.seasonal_grid(self.ds)
        self.assertAlmostEqual(arr[-1, 3, 3] / 100, float(grid[-1, 3, 3]), places=2)

    def test_monthly_frames(self):
        (y0, m0), count, payload = ga.monthly_frames(self.ds, 1990, 2050)
        self.assertEqual((y0, m0), (1990, 1))
        last_y, last_m = self.ds.last_month
        self.assertEqual(count, (last_y - 1990) * 12 + last_m)
        arr = np.frombuffer(payload, dtype="<i2").reshape(count, self.ds.lats.size, self.ds.lons.size)
        k = int(np.nonzero((self.ds.years == 1990) & (self.ds.months == 3))[0][0])
        self.assertAlmostEqual(arr[2, 3, 3] / 100, float(self.ds.values[k, 3, 3]), places=2)
        # a different baseline shifts every month by its own climatology
        _, _, shifted = ga.monthly_frames(self.ds, 1990, 1990, baseline="1981-2010")
        arr2 = np.frombuffer(shifted, dtype="<i2").reshape(12, self.ds.lats.size, self.ds.lons.size)
        self.assertLess(arr2[2, 3, 3], arr[2, 3, 3])
        # long ranges are capped
        _, count, _ = ga.monthly_frames(self.ds, 1900, 2000)
        self.assertEqual(count, ga.MAX_MONTHLY_YEARS * 12)
        with self.assertRaises(ga.AnalysisInputError):
            ga.monthly_frames(self.ds, "abc", 2000)

    def test_zonal(self):
        z = ga.zonal(self.ds)
        self.assertEqual(len(z["values"]), len(z["years"]) * len(z["lats"]))

    def test_ranking_sorted(self):
        rows = ga.ranking(self.ds, 1950, 1999)["rows"]
        trends = [r["trend"] for r in rows if r["trend"] is not None]
        self.assertEqual(trends, sorted(trends, reverse=True))


class PrecipitationTest(unittest.TestCase):
    def setUp(self):
        ga.clear_cache()
        ds = make_dataset(first=1979, last_year=2024, slope_per_year=0.001, noise=0.05)
        ds.kind = "precipitation"
        ds.unit = "mm/Tag"
        ds.baseline = (1991, 2020)
        ds.baselines = ("1991-2020", "1981-2010")
        ds.clim = np.full(ds.values.shape[1:], 2.0, dtype=np.float32)
        ds.clim[0, 1] = 0.01  # a desert cell: no relative trend
        self.ds = ds

    def test_relative_trend_layer_and_stats(self):
        info = ga.layer_info(self.ds)
        self.assertIn("trend_rel", info)
        self.assertEqual(info["trend"]["unit"], "mm/Tag/Dekade")
        out = ga.layer(self.ds, "trend_rel", 1979, 2024)
        trend = ga.layer(self.ds, "trend", 1979, 2024)
        k = self.ds.lons.size * 3 + 2
        self.assertAlmostEqual(out["values"][k], trend["values"][k] / 2.0 * 100, delta=0.05)
        self.assertIsNone(out["values"][1])
        region = ga.parse_region({"point": [float(self.ds.lons[2]), float(self.ds.lats[3])]})
        stats = ga.region_series(self.ds, [region], 1979, 2024)["regions"][0]["stats"]
        self.assertAlmostEqual(stats["trend_rel"], stats["trend"] / 2.0 * 100, delta=0.05)
        self.assertNotIn("vs_global", stats)

    def test_relative_trend_uses_seasonal_climatology(self):
        monthly = np.full((12,) + self.ds.values.shape[1:], 1.0, dtype=np.float32)
        monthly[5:8] = 4.0  # wet summer: JJA climatology 4 mm/day
        self.ds.clim_monthly = monthly
        region = ga.parse_region({"point": [float(self.ds.lons[2]), float(self.ds.lats[3])]})
        stats = ga.region_series(self.ds, [region], 1979, 2024, season="JJA")["regions"][0]["stats"]
        self.assertAlmostEqual(stats["clim"], 4.0, places=3)
        self.assertAlmostEqual(stats["trend_rel"], stats["trend"] / 4.0 * 100, delta=0.05)

    def test_baselines_are_per_dataset(self):
        with self.assertRaises(ga.AnalysisInputError):
            ga.layer(self.ds, "trend", 1979, 2024, baseline="1951-1980")
        ga.layer(self.ds, "anomaly", 1979, 2024, baseline="1981-2010")

    def test_temperature_has_no_relative_layer(self):
        self.assertNotIn("trend_rel", ga.layer_info(make_dataset()))


class FakeHandler:
    def __init__(self):
        self.status = None
        self.body = None
        self.headers = {}
        self.wfile = io.BytesIO()

    def _send_json(self, status, data):
        self.status = status
        self.body = data

    def send_response(self, status):
        self.status = status

    def send_header(self, k, v):
        self.headers[k] = v

    def end_headers(self):
        pass


class ApiTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        ga.clear_cache()
        gd.set_dataset(make_dataset())

    @classmethod
    def tearDownClass(cls):
        gd.set_dataset(None)
        ga.clear_cache()

    def get(self, path, query=""):
        h = FakeHandler()
        handled = global_api.handle_get(h, path, query)
        return handled, h

    def test_routes(self):
        self.assertFalse(self.get("/api/topics")[0])
        _, h = self.get("/api/global/meta")
        self.assertEqual(h.status, 200)
        self.assertGreater(len(h.body["presets"]), 10)
        self.assertEqual({d["id"] for d in h.body["datasets"]}, {"gistemp", "gpcp"})
        _, h = self.get("/api/global/layer", "kind=snr&start=1950&end=1999")
        self.assertEqual(h.status, 200)
        _, h = self.get("/api/global/regions", "ids=global,arctic&start=1950&end=1999")
        self.assertEqual([r["id"] for r in h.body["regions"]], ["global", "arctic"])
        _, h = self.get("/api/global/regions", "custom=" + json.dumps([{"bbox": [0, 0, 40, 40], "name": "Box"}]))
        self.assertEqual(h.body["regions"][0]["name"], "Box")
        _, h = self.get("/api/global/cell", "lat=50&lon=10")
        self.assertEqual(h.status, 200)
        _, h = self.get("/api/global/frames")
        self.assertEqual(h.status, 200)
        self.assertGreater(len(h.wfile.getvalue()), 0)
        _, h = self.get("/api/global/frames", "res=monthly&from=1990&to=1999")
        self.assertEqual((h.status, h.headers["X-Start"], h.headers["X-Count"]), (200, "1990-01", "120"))

    def test_errors(self):
        for path, query in [
            ("/api/global/layer", "kind=bogus"),
            ("/api/global/layer", "start=abc"),
            ("/api/global/regions", ""),
            ("/api/global/regions", "custom={broken"),
            ("/api/global/zonal", "season=XYZ"),
            ("/api/global/layer", "baseline=1800-1830"),
            ("/api/global/distribution", "region=nope"),
        ]:
            _, h = self.get(path, query)
            self.assertEqual(h.status, 400, (path, query, h.body))
        _, h = self.get("/api/global/nothing")
        self.assertEqual(h.status, 404)


if __name__ == "__main__":
    unittest.main()
