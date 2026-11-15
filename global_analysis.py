"""Trend analysis on the global anomaly grid (Global Explorer).

Everything here works on a :class:`global_data.GriddedDataset` and returns
JSON-ready dicts. The methods follow common practice in climate science
(IPCC AR6 WG1, Ch. 2 / Cross-Chapter Box 2.3):

* **Seasonal / annual means** from monthly anomalies. A year counts for a
  cell when at least two thirds of its months have a value; years that the
  dataset does not fully cover yet (the running year) are left out.
* **Baseline**: anomalies can be re-referenced to another 30-year period;
  this shifts values per cell and never changes a trend.
* **Linear trend** (ordinary least squares) with a 95 % confidence interval
  and p-value corrected for lag-1 autocorrelation of the residuals
  (effective sample size, Santer et al. 2000, JGR 105, 7337).
* **Theil–Sen slope** and **Mann–Kendall** test (robust, non-parametric) for
  region series.
* **Acceleration**: trend of the second half of the period minus the trend of
  the first half.
* **Signal-to-noise**: linear change over the period divided by the standard
  deviation of the detrended year-to-year variability.
* **Spatial gradient** of the trend field (°C/decade per 1000 km): where the
  pace of warming changes sharply between neighbouring regions.
* **Time of emergence**: first year after which the 11-year running mean stays
  above twice the year-to-year standard deviation of the baseline period
  (cf. Hawkins & Sutton 2012, GRL 39, L01702).

Nothing is filled in where the source has no data: an empty grid cell stays
empty, and region means are only reported when enough of the region's area
has data (``MIN_REGION_COVERAGE``).
"""

from __future__ import annotations

import math
import threading
import warnings
from collections import OrderedDict
from dataclasses import dataclass
from typing import Any, Callable, Sequence

import numpy as np
from scipy import stats

from global_data import GriddedDataset

EARTH_RADIUS_KM: float = 6371.0
MIN_REGION_COVERAGE: float = 0.33
MIN_YEARS: int = 10

SEASONS: dict[str, tuple[str, tuple[int, ...]]] = {
    "annual": ("Jahr", tuple(range(1, 13))),
    "DJF": ("Winter (DJF)", (12, 1, 2)),
    "MAM": ("Frühling (MAM)", (3, 4, 5)),
    "JJA": ("Sommer (JJA)", (6, 7, 8)),
    "SON": ("Herbst (SON)", (9, 10, 11)),
}
MONTH_NAMES = ["Jan", "Feb", "Mär", "Apr", "Mai", "Jun", "Jul", "Aug", "Sep", "Okt", "Nov", "Dez"]

BASELINES: dict[str, tuple[int, int]] = {
    "1951-1980": (1951, 1980),
    "1991-2020": (1991, 2020),
    "1880-1900": (1880, 1900),
    "1961-1990": (1961, 1990),
    "1981-2010": (1981, 2010),
}

def layer_info(ds: GriddedDataset) -> dict[str, dict[str, str]]:
    """Labels and units of the map layers for this dataset's variable."""
    u = ds.unit
    warm = ds.kind == "temperature"
    info = {
        "trend": {"label": "Erwärmungstrend" if warm else "Niederschlagstrend", "unit": f"{u}/Dekade"},
        "anomaly": {"label": "Mittlere Anomalie im Zeitraum", "unit": u},
        "acceleration": {"label": "Beschleunigung (Trend 2. Hälfte − 1. Hälfte)", "unit": f"{u}/Dekade"},
        "snr": {"label": "Signal-Rausch-Verhältnis", "unit": "σ"},
        "gradient": {"label": "Räumlicher Gradient des Trends", "unit": f"{u}/Dekade pro 1000 km"},
    }
    if ds.clim is not None:
        info["trend_rel"] = {"label": "Relativer Trend (zum Klimamittel)", "unit": "%/Dekade"}
    return info


LAYERS: dict[str, dict[str, str]] = {
    "trend": {"label": "Erwärmungstrend", "unit": "°C/Dekade"},
    "anomaly": {"label": "Mittlere Anomalie im Zeitraum", "unit": "°C"},
    "acceleration": {"label": "Beschleunigung (Trend 2. Hälfte − 1. Hälfte)", "unit": "°C/Dekade"},
    "snr": {"label": "Signal-Rausch-Verhältnis", "unit": "σ"},
    "gradient": {"label": "Räumlicher Gradient des Trends", "unit": "°C/Dekade pro 1000 km"},
}


class AnalysisInputError(ValueError):
    """Invalid user input (unknown season, empty period, ...)."""


# ---------------------------------------------------------------------------
# Regions
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class Region:
    """A named area: a bounding box ``[west, south, east, north]`` or a polygon.

    ``west > east`` means the box crosses the 180° meridian.
    """

    id: str
    name: str
    group: str
    bbox: tuple[float, float, float, float] | None = None
    polygon: tuple[tuple[float, float], ...] | None = None
    note: str = ""

    def __post_init__(self) -> None:
        if (self.bbox is None) == (self.polygon is None):
            raise ValueError(f"Region {self.id}: genau eins von bbox oder polygon angeben")
        if self.polygon is not None and not all(
            isinstance(p, (tuple, list)) and len(p) == 2 for p in self.polygon
        ):
            raise ValueError(f"Region {self.id}: Polygon braucht (lon, lat)-Paare")

    def outline(self) -> list[list[float]]:
        """Closed ring in lon/lat (longitudes may exceed 180 to stay continuous)."""
        if self.polygon:
            ring = [list(p) for p in self.polygon]
        else:
            w, s, e, n = self.bbox  # type: ignore[misc]
            if w > e:
                e += 360.0
            ring = []
            steps = max(2, int((e - w) / 5))
            for i in range(steps + 1):
                ring.append([w + (e - w) * i / steps, s])
            for i in range(steps + 1):
                ring.append([e - (e - w) * i / steps, n])
        if ring[0] != ring[-1]:
            ring.append(ring[0])
        return ring

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "group": self.group,
            "bbox": list(self.bbox) if self.bbox else None,
            "outline": self.outline(),
            "note": self.note,
        }


_MEDITERRANEAN = (
    (-6.0, 35.0), (-5.5, 36.5), (-2.0, 37.0), (0.5, 39.0), (0.0, 40.5), (3.5, 43.5),
    (8.5, 44.5), (12.5, 44.5), (13.8, 45.8), (16.5, 43.5), (19.5, 41.5), (18.5, 40.0),
    (16.5, 38.5), (20.5, 39.5), (23.0, 40.8), (26.5, 41.0), (26.5, 38.5), (28.5, 36.8),
    (36.2, 36.8), (35.8, 34.5), (34.3, 31.3), (30.0, 31.3), (25.0, 31.8), (20.0, 30.5),
    (15.5, 31.5), (11.0, 33.0), (10.0, 37.3), (6.0, 37.0), (0.0, 35.8), (-6.0, 35.0),
)

PRESET_REGIONS: list[Region] = [
    Region("global", "Ganze Welt", "Global", (-180, -90, 180, 90)),
    Region("nh", "Nordhalbkugel", "Global", (-180, 0, 180, 90)),
    Region("sh", "Südhalbkugel", "Global", (-180, -90, 180, 0)),
    Region("tropics", "Tropen (23,4°S–23,4°N)", "Global", (-180, -23.44, 180, 23.44)),
    Region("arctic", "Arktis (nördl. 66,5°N)", "Polar", (-180, 66.56, 180, 90)),
    Region("antarctica", "Antarktis (südl. 64°S)", "Polar", (-180, -90, 180, -64),
           note="Vor 1957 kaum Messungen – frühe Jahre ohne Wert."),
    Region("southern_ocean", "Südpolarmeer (50–64°S)", "Polar", (-180, -64, 180, -50)),
    Region("nrw", "Nordrhein-Westfalen", "Europa", (5.87, 50.32, 9.46, 52.53),
           note="Kleiner als wenige 2°-Gitterzellen – Werte sind flächengewichtete Zellanteile."),
    Region("germany", "Deutschland", "Europa", (5.87, 47.27, 15.04, 55.06)),
    Region("europe", "Europa", "Europa", (-25, 35, 45, 71)),
    Region("scandinavia", "Skandinavien", "Europa", (4.5, 55, 31.5, 71.5)),
    Region("iberia", "Iberische Halbinsel", "Europa", (-9.5, 36, 3.3, 43.8)),
    Region("mediterranean", "Mittelmeer", "Meere", polygon=_MEDITERRANEAN,
           note="Grobe Küstenlinie; 2°-Zellen enthalten auch Küstenland."),
    Region("north_atlantic", "Nordatlantik", "Meere", (-75, 0, -10, 65)),
    Region("south_pacific", "Südpazifik", "Meere", (160, -50, -70, -10)),
    Region("nino34", "Niño-3.4 (trop. Pazifik)", "Meere", (-170, -5, -120, 5),
           note="Index-Region für El Niño / La Niña."),
    Region("indian_ocean", "Indischer Ozean", "Meere", (40, -40, 110, 20)),
    Region("north_america", "Nordamerika", "Kontinente", (-168, 15, -52, 72)),
    Region("south_america", "Südamerika", "Kontinente", (-82, -56, -34, 13)),
    Region("africa", "Afrika", "Kontinente", (-18, -35, 52, 37)),
    Region("asia", "Asien", "Kontinente", (60, 5, 150, 75)),
    Region("australia", "Australien", "Kontinente", (112, -44, 154, -10)),
    Region("siberia", "Sibirien", "Landschaften", (60, 50, 180, 75)),
    Region("sahara", "Sahara", "Landschaften", (-17, 15, 35, 33)),
    Region("amazon", "Amazonas-Becken", "Landschaften", (-75, -15, -45, 5)),
    Region("himalaya", "Himalaya / Tibet", "Landschaften", (70, 26, 105, 40)),
]
PRESETS_BY_ID: dict[str, Region] = {r.id: r for r in PRESET_REGIONS}


def _float(value: Any, name: str) -> float:
    try:
        result = float(value)
    except (TypeError, ValueError) as exc:
        raise AnalysisInputError(f"{name} ist keine Zahl") from exc
    if not math.isfinite(result):
        raise AnalysisInputError(f"{name} ist keine endliche Zahl")
    return result


def parse_region(spec: Any) -> Region:
    """Accept a preset id, ``{"preset": id}``, ``{"bbox": [...]}``, ``{"polygon": [...]}``
    or ``{"point": [lon, lat]}`` and return a :class:`Region`."""
    if isinstance(spec, str):
        spec = {"preset": spec}
    if not isinstance(spec, dict):
        raise AnalysisInputError("Region muss ein Objekt sein")
    if "preset" in spec:
        region = PRESETS_BY_ID.get(str(spec["preset"]))
        if region is None:
            raise AnalysisInputError(f"Unbekannte Region: {spec['preset']}")
        return region
    name = str(spec.get("name") or "Eigene Region")[:80]
    rid = str(spec.get("id") or "custom")[:80]
    if "point" in spec:
        lon, lat = (_float(v, "Koordinate") for v in spec["point"][:2])
        if not -90 <= lat <= 90:
            raise AnalysisInputError("Breite außerhalb von ±90°")
        lon = ((lon + 180.0) % 360.0) - 180.0
        # The point stands for its 2° grid cell; a tiny box picks that cell.
        eps = 1e-6
        return Region(rid, name, "Eigene", (lon - eps, max(-90, lat - eps), lon + eps, min(90, lat + eps)),
                      note="Einzelne Gitterzelle (2° × 2°, ca. 220 km).")
    if "bbox" in spec:
        values = spec["bbox"]
        if not isinstance(values, (list, tuple)) or len(values) != 4:
            raise AnalysisInputError("bbox braucht [West, Süd, Ost, Nord]")
        w, s, e, n = (_float(v, "bbox") for v in values)
        if not (-90 <= s < n <= 90):
            raise AnalysisInputError("bbox: Süd muss kleiner als Nord sein (±90°)")
        if e - w >= 360:
            w, e = -180.0, 180.0
        else:
            w = ((w + 180.0) % 360.0) - 180.0
            e = ((e + 180.0) % 360.0) - 180.0
            if e == -180.0 and w > e:
                e = 180.0
        return Region(rid, name, "Eigene", (w, s, e, n))
    if "polygon" in spec:
        points = spec["polygon"]
        if not isinstance(points, (list, tuple)) or len(points) < 3:
            raise AnalysisInputError("Polygon braucht mindestens 3 Punkte")
        ring = tuple((_float(p[0], "Polygon"), _float(p[1], "Polygon")) for p in points[:2000])
        return Region(rid, name, "Eigene", polygon=ring)
    raise AnalysisInputError("Region braucht preset, bbox, polygon oder point")


def _overlap(lo: np.ndarray, hi: np.ndarray, a: float, b: float) -> np.ndarray:
    return np.clip(np.minimum(hi, b) - np.maximum(lo, a), 0.0, None)


def _points_in_polygon(lon: np.ndarray, lat: np.ndarray, ring: Sequence[tuple[float, float]]) -> np.ndarray:
    """Even–odd rule, vectorised over points."""
    inside = np.zeros(lon.shape, dtype=bool)
    n = len(ring)
    for i in range(n):
        x1, y1 = ring[i]
        x2, y2 = ring[(i + 1) % n]
        if y1 == y2:
            continue
        crosses = (y1 > lat) != (y2 > lat)
        x_cross = x1 + (lat - y1) * (x2 - x1) / (y2 - y1)
        inside ^= crosses & (lon < x_cross)
    return inside


def region_weights(ds: GriddedDataset, region: Region) -> np.ndarray:
    """Area weight of every grid cell for ``region`` (cos(lat) × overlapped fraction)."""
    half_lat = ds.lat_step / 2
    half_lon = ds.lon_step / 2
    cos_lat = np.cos(np.deg2rad(ds.lats))
    if region.bbox is not None:
        w, s, e, n = region.bbox
        if 0 <= e - w < 1e-3 and n - s < 1e-3:  # a point: exactly the cell containing it
            return _nearest_cell(ds, (s + n) / 2, (w + e) / 2)
        lat_frac = _overlap(ds.lats - half_lat, ds.lats + half_lat, s, n) / ds.lat_step
        lo, hi = ds.lons - half_lon, ds.lons + half_lon
        if w <= e:
            lon_frac = _overlap(lo, hi, w, e)
        else:  # crosses the date line
            lon_frac = _overlap(lo, hi, w, 180.0) + _overlap(lo, hi, -180.0, e)
        lon_frac = lon_frac / ds.lon_step
        weights = (lat_frac * cos_lat)[:, None] * lon_frac[None, :]
        if weights.sum() == 0:  # degenerate box: take the cell containing its centre
            weights = _nearest_cell(ds, (s + n) / 2, w if w == e else (w + e) / 2)
        return weights
    ring = region.polygon or ()
    lon_grid, lat_grid = np.meshgrid(ds.lons, ds.lats)
    inside = _points_in_polygon(lon_grid, lat_grid, ring)
    inside |= _points_in_polygon(lon_grid + 360.0, lat_grid, ring)
    inside |= _points_in_polygon(lon_grid - 360.0, lat_grid, ring)
    weights = inside * cos_lat[:, None]
    if weights.sum() == 0:
        lons = [p[0] for p in ring]
        lats = [p[1] for p in ring]
        weights = _nearest_cell(ds, float(np.mean(lats)), float(np.mean(lons)))
    return weights


def _nearest_cell(ds: GriddedDataset, lat: float, lon: float) -> np.ndarray:
    weights = np.zeros((ds.lats.size, ds.lons.size))
    i = int(np.argmin(np.abs(ds.lats - lat)))
    lon = ((lon + 180.0) % 360.0) - 180.0
    j = int(np.argmin(np.abs(((ds.lons - lon + 180.0) % 360.0) - 180.0)))
    weights[i, j] = math.cos(math.radians(ds.lats[i]))
    return weights


def region_area_km2(ds: GriddedDataset, weights: np.ndarray) -> float:
    cell = (math.radians(ds.lat_step) * math.radians(ds.lon_step)) * EARTH_RADIUS_KM**2
    return float(weights.sum() * cell)


# ---------------------------------------------------------------------------
# Seasonal means (cached)
# ---------------------------------------------------------------------------

_cache_lock = threading.Lock()
_season_cache: "OrderedDict[tuple, tuple[np.ndarray, np.ndarray]]" = OrderedDict()
_CACHE_SIZE = 8


def _cached(key: tuple, build: Callable[[], Any]) -> Any:
    with _cache_lock:
        if key in _season_cache:
            _season_cache.move_to_end(key)
            return _season_cache[key]
    value = build()
    with _cache_lock:
        _season_cache[key] = value
        while len(_season_cache) > _CACHE_SIZE:
            _season_cache.popitem(last=False)
    return value


def clear_cache() -> None:
    with _cache_lock:
        _season_cache.clear()


def _monthly_cube(ds: GriddedDataset) -> tuple[np.ndarray, np.ndarray]:
    """Return ``(years, cube[year, month, lat, lon])``, NaN-padded to whole years."""
    def build() -> tuple[np.ndarray, np.ndarray]:
        first = int(ds.years[0])
        last = int(ds.years[-1])
        years = np.arange(first, last + 1)
        cube = np.full((years.size, 12) + ds.values.shape[1:], np.nan, dtype=np.float32)
        cube[ds.years - first, ds.months - 1] = ds.values
        return years, cube

    return _cached((id(ds), "cube"), build)


def season_spec(season: str) -> tuple[str, tuple[int, ...]]:
    if season in SEASONS:
        return SEASONS[season]
    if season.startswith("m") and season[1:].isdigit() and 1 <= int(season[1:]) <= 12:
        month = int(season[1:])
        return MONTH_NAMES[month - 1], (month,)
    raise AnalysisInputError(f"Unbekannte Jahreszeit: {season}")


def _season_from_monthly(years: np.ndarray, cube: np.ndarray, months: tuple[int, ...],
                         last: tuple[int, int]) -> tuple[np.ndarray, np.ndarray]:
    """Mean over ``months`` per year (December belongs to the following winter)."""
    parts = []
    for m in months:
        if m == 12 and 1 in months and len(months) < 12:  # DJF: previous December
            shifted = np.full_like(cube[:, 0], np.nan)
            shifted[1:] = cube[:-1, 11]
            parts.append(shifted)
        else:
            parts.append(cube[:, m - 1])
    stack = np.stack(parts)  # (k, years, ...)
    valid = np.isfinite(stack).sum(axis=0)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)
        mean = np.nanmean(stack, axis=0)
    mean[valid < math.ceil(len(months) * 2 / 3)] = np.nan
    # Drop years the dataset does not fully cover yet (the running season).
    last_year, last_month = last
    is_winter = 12 in months and 1 in months and len(months) < 12
    in_label_year = [m for m in months if not (is_winter and m == 12)]
    keep = years < last_year
    if max(in_label_year) <= last_month:
        keep = keep | (years == last_year)
    if is_winter:
        keep &= years > years[0]  # first winter lacks its December
    return years[keep], mean[keep]


def seasonal_grid(ds: GriddedDataset, season: str = "annual",
                  baseline: str | None = None) -> tuple[np.ndarray, np.ndarray]:
    """``(years, grid[year, lat, lon])`` of seasonal mean anomalies."""
    _, months = season_spec(season)
    base = _baseline(baseline, ds)

    def build() -> tuple[np.ndarray, np.ndarray]:
        years, cube = _monthly_cube(ds)
        yrs, grid = _season_from_monthly(years, cube, months, ds.last_month)
        if base is not None and base != tuple(ds.baseline):
            sel = (yrs >= base[0]) & (yrs <= base[1])
            count = np.isfinite(grid[sel]).sum(axis=0)
            with warnings.catch_warnings():
                warnings.simplefilter("ignore", RuntimeWarning)
                ref = np.nanmean(grid[sel], axis=0)
            ref[count < max(1, int(sel.sum() * 2 / 3))] = np.nan
            grid = grid - ref[None]
        return yrs, grid.astype(np.float32)

    return _cached((id(ds), "season", season, base), build)


def _baseline(baseline: str | None, ds: GriddedDataset) -> tuple[int, int] | None:
    if baseline in (None, "", "native"):
        return tuple(ds.baseline)  # type: ignore[return-value]
    if baseline not in BASELINES or baseline not in ds.baselines:
        raise AnalysisInputError(f"Referenzperiode {baseline} gibt es für diesen Datensatz nicht")
    return BASELINES[baseline]


def _period(years: np.ndarray, start: Any, end: Any) -> tuple[int, int, np.ndarray]:
    first, last = int(years[0]), int(years[-1])
    start_y = int(start) if start not in (None, "") else first
    end_y = int(end) if end not in (None, "") else last
    start_y = max(first, start_y)
    end_y = min(last, end_y)
    if end_y - start_y + 1 < MIN_YEARS:
        raise AnalysisInputError(f"Zeitraum muss mindestens {MIN_YEARS} Jahre umfassen ({first}–{last})")
    return start_y, end_y, (years >= start_y) & (years <= end_y)


# ---------------------------------------------------------------------------
# Trend statistics
# ---------------------------------------------------------------------------

def ols_trend(x: np.ndarray, y: np.ndarray, min_fraction: float = 2 / 3) -> dict[str, np.ndarray]:
    """Least-squares slope along axis 0 for every column of ``y`` (NaN-aware).

    Returns slope (per unit of ``x``), its AR(1)-adjusted standard error,
    two-sided p-value, 95 % half-width, lag-1 autocorrelation, residual std,
    intercept at the mean of x, and the number of valid values. Columns with
    fewer than ``min_fraction`` of the values, or with a whole third of the
    period missing, get NaN.
    """
    y = np.asarray(y, dtype=np.float64)
    shape = y.shape[1:]
    y2 = y.reshape(y.shape[0], -1)
    x = np.asarray(x, dtype=np.float64)
    mask = np.isfinite(y2)
    n = mask.sum(axis=0).astype(np.float64)
    with np.errstate(invalid="ignore", divide="ignore"):
        xm = (x[:, None] * mask).sum(axis=0) / n
        ym = np.where(mask, y2, 0.0).sum(axis=0) / n
        dx = np.where(mask, x[:, None] - xm, 0.0)
        dy = np.where(mask, y2 - ym, 0.0)
        sxx = (dx * dx).sum(axis=0)
        slope = (dx * dy).sum(axis=0) / sxx
        resid = np.where(mask, dy - slope * dx, np.nan)
        sse = np.nansum(resid**2, axis=0)
        r0 = resid[:-1]
        r1v = resid[1:]
        pair = np.isfinite(r0) & np.isfinite(r1v)
        lag1 = np.where(pair, r0 * r1v, 0.0).sum(axis=0) / sse
        lag1 = np.clip(np.nan_to_num(lag1), 0.0, 0.95)
        n_eff = np.maximum(n * (1 - lag1) / (1 + lag1), 3.0)
        n_eff = np.minimum(n_eff, n)
        se = np.sqrt(sse / (n_eff - 2) / sxx)
        tstat = slope / se
        pval = 2 * stats.t.sf(np.abs(tstat), n_eff - 2)
        half = stats.t.ppf(0.975, n_eff - 2) * se
        resid_std = np.sqrt(sse / np.maximum(n - 2, 1))
    total = y.shape[0]
    enough = n >= max(3, math.ceil(total * min_fraction))
    thirds = np.array_split(np.arange(total), 3)
    for part in thirds:
        if part.size:
            enough &= mask[part].any(axis=0)
    out = {
        "slope": slope, "se": se, "p": pval, "ci": half, "r1": lag1, "n_eff": n_eff,
        "resid_std": resid_std, "intercept": ym, "x_mean": xm, "n": n,
    }
    for key, value in out.items():
        value = np.where(enough, value, np.nan)
        out[key] = value.reshape(shape) if shape else value.reshape(())
    return out


def _round_list(arr: np.ndarray, digits: int = 3) -> list[float | None]:
    flat = np.asarray(arr, dtype=np.float64).ravel()
    rounded = np.round(flat, digits)
    return [None if not math.isfinite(v) else float(v) for v in rounded]


def _num(value: Any, digits: int = 4) -> float | None:
    try:
        value = float(value)
    except (TypeError, ValueError):
        return None
    return round(value, digits) if math.isfinite(value) else None


# ---------------------------------------------------------------------------
# Map layers
# ---------------------------------------------------------------------------

def _spatial_gradient(ds: GriddedDataset, field: np.ndarray) -> np.ndarray:
    """|∇field| in units of field per 1000 km (central differences, lon wraps)."""
    dy_km = math.radians(ds.lat_step) * EARTH_RADIUS_KM
    dx_km = math.radians(ds.lon_step) * EARTH_RADIUS_KM * np.cos(np.deg2rad(ds.lats))[:, None]
    ddx = (np.roll(field, -1, axis=1) - np.roll(field, 1, axis=1)) / (2 * dx_km)
    ddy = np.full_like(field, np.nan)
    ddy[1:-1] = (field[2:] - field[:-2]) / (2 * dy_km)
    return np.sqrt(ddx**2 + ddy**2) * 1000.0


def layer(ds: GriddedDataset, kind: str = "trend", start: Any = None, end: Any = None,
          season: str = "annual", baseline: str | None = None) -> dict[str, Any]:
    """One map layer as a flat grid (rows south → north, columns west → east)."""
    info = layer_info(ds)
    if kind not in info:
        raise AnalysisInputError(f"Unbekannte Ebene: {kind}")
    years, grid = seasonal_grid(ds, season, baseline)
    start_y, end_y, sel = _period(years, start, end)
    x = years[sel].astype(np.float64)
    y = grid[sel]
    sig = None
    if kind in ("trend", "trend_rel"):
        fit = ols_trend(x, y)
        values = fit["slope"] * 10
        if kind == "trend_rel":
            with np.errstate(invalid="ignore", divide="ignore"):
                clim = season_clim(ds, season)
                values = np.where(clim > 0.1, values / clim * 100, np.nan)  # skip near-rainless cells
        sig = fit["p"] < 0.05
        sig = np.where(np.isfinite(values), sig, False)
    elif kind == "anomaly":
        count = np.isfinite(y).sum(axis=0)
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", RuntimeWarning)
            values = np.nanmean(y, axis=0)
        values[count < math.ceil(y.shape[0] * 2 / 3)] = np.nan
    elif kind == "acceleration":
        mid = (start_y + end_y) // 2
        a = ols_trend(x[x <= mid], y[x <= mid])
        b = ols_trend(x[x > mid], y[x > mid])
        values = (b["slope"] - a["slope"]) * 10
        diff_se = np.sqrt(a["se"] ** 2 + b["se"] ** 2)
        with np.errstate(invalid="ignore"):
            sig = np.abs(b["slope"] - a["slope"]) > 1.96 * diff_se
        sig = np.where(np.isfinite(values), sig, False)
    elif kind == "snr":
        fit = ols_trend(x, y)
        with np.errstate(invalid="ignore", divide="ignore"):
            values = fit["slope"] * (end_y - start_y) / fit["resid_std"]
        sig = np.where(np.isfinite(values), fit["p"] < 0.05, False)
    else:  # gradient
        fit = ols_trend(x, y)
        values = _spatial_gradient(ds, fit["slope"] * 10)
    finite = values[np.isfinite(values)]
    weights = np.broadcast_to(np.cos(np.deg2rad(ds.lats))[:, None], values.shape)
    wsel = weights[np.isfinite(values)]
    summary: dict[str, Any] = {
        "coverage": _num(wsel.sum() / weights.sum(), 3),
        "p02": _num(np.percentile(finite, 2)) if finite.size else None,
        "p98": _num(np.percentile(finite, 98)) if finite.size else None,
        "min": _num(finite.min()) if finite.size else None,
        "max": _num(finite.max()) if finite.size else None,
        "area_mean": _num((finite * wsel).sum() / wsel.sum()) if finite.size else None,
    }
    if sig is not None:
        summary["significant_area"] = _num((wsel * sig[np.isfinite(values)]).sum() / wsel.sum(), 3) if finite.size else None
    return {
        "kind": kind,
        **info[kind],
        "season": season,
        "season_label": season_spec(season)[0],
        "baseline": list(_baseline(baseline, ds) or ds.baseline),
        "period": [start_y, end_y],
        "nlat": int(ds.lats.size),
        "nlon": int(ds.lons.size),
        "values": _round_list(values, 3),
        "significant": None if sig is None else [bool(v) for v in np.asarray(sig).ravel()],
        "summary": summary,
    }


def frames(ds: GriddedDataset, season: str = "annual", baseline: str | None = None) -> tuple[list[int], bytes]:
    """All yearly anomaly maps as little-endian int16 in 1/100 °C (−32768 = no data)."""
    years, grid = seasonal_grid(ds, season, baseline)
    scaled = np.round(np.nan_to_num(grid, nan=-327.68) * 100)
    scaled = np.clip(scaled, -32768, 32767).astype("<i2")
    return [int(y) for y in years], scaled.tobytes()


MAX_MONTHLY_YEARS = 20


def _monthly_reference(ds: GriddedDataset, base: tuple[int, int]) -> np.ndarray | None:
    """Per-month shift ``[12, lat, lon]`` from the dataset's own baseline to ``base``."""
    if tuple(ds.baseline) == tuple(base):
        return None

    def build() -> np.ndarray:
        years, cube = _monthly_cube(ds)
        sel = (years >= base[0]) & (years <= base[1])
        part = cube[sel]
        count = np.isfinite(part).sum(axis=0)
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", RuntimeWarning)
            ref = np.nanmean(part, axis=0)
        ref[count < max(1, int(sel.sum() * 2 / 3))] = np.nan
        return ref.astype(np.float32)

    return _cached((id(ds), "mref", base), build)


def monthly_frames(ds: GriddedDataset, start: Any, end: Any,
                   baseline: str | None = None) -> tuple[tuple[int, int], int, bytes]:
    """Monthly anomaly maps from January ``start`` on, int16 in 1/100 unit.

    Returns ``((first_year, 1), month_count, payload)``; the range is clipped to the
    data and to ``MAX_MONTHLY_YEARS`` so a single answer stays a few MB.
    """
    years, cube = _monthly_cube(ds)
    first, last = int(years[0]), int(years[-1])
    try:
        y0 = max(first, int(start))
        y1 = min(last, int(end), y0 + MAX_MONTHLY_YEARS - 1)
    except (TypeError, ValueError) as exc:
        raise AnalysisInputError("from/to müssen Jahreszahlen sein") from exc
    if y1 < y0:
        raise AnalysisInputError(f"Keine Monatsdaten im Bereich {start}–{end} ({first}–{last})")
    part = cube[y0 - first: y1 - first + 1]
    ref = _monthly_reference(ds, _baseline(baseline, ds))
    if ref is not None:
        part = part - ref[None]
    flat = part.reshape((-1,) + part.shape[2:])
    last_y, last_m = ds.last_month
    count = flat.shape[0]
    if y1 == last_y:
        count -= 12 - last_m
    scaled = np.round(np.nan_to_num(flat[:count], nan=-327.68) * 100)
    return (y0, 1), count, np.clip(scaled, -32768, 32767).astype("<i2").tobytes()


def cell_series(ds: GriddedDataset, lat: float, lon: float, season: str = "annual",
                baseline: str | None = None) -> dict[str, Any]:
    region = parse_region({"point": [lon, lat], "name": f"{lat:.1f}°, {lon:.1f}°"})
    return region_series(ds, [region], season=season, baseline=baseline)["regions"][0]


# ---------------------------------------------------------------------------
# Region series and statistics
# ---------------------------------------------------------------------------

def _area_mean(grid: np.ndarray, weights: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    idx = np.nonzero(weights)
    w = weights[idx]
    vals = grid[(slice(None),) + idx].astype(np.float64)
    valid = np.isfinite(vals)
    wsum = (valid * w).sum(axis=1)
    with np.errstate(invalid="ignore", divide="ignore"):
        mean = np.where(valid, vals, 0.0) @ w / wsum
    coverage = wsum / w.sum()
    mean[coverage < MIN_REGION_COVERAGE] = np.nan
    return mean, coverage


def _running_mean(values: np.ndarray, window: int = 11) -> np.ndarray:
    half = window // 2
    out = np.full(values.shape, np.nan)
    for i in range(values.size):
        part = values[max(0, i - half): i + half + 1]
        ok = part[np.isfinite(part)]
        if ok.size >= math.ceil(window * 0.7) and i - half >= 0 and i + half < values.size:
            out[i] = ok.mean()
    return out


ROLLING_WINDOW: int = 30


def rolling_trend(years: np.ndarray, values: np.ndarray, window: int = ROLLING_WINDOW) -> tuple[np.ndarray, np.ndarray]:
    """Trend (°C/decade) and its 95 % half-width over the ``window`` years ending in each year."""
    slope = np.full(values.shape, np.nan)
    half = np.full(values.shape, np.nan)
    if values.size < window:
        return slope, half
    idx = np.arange(window - 1, values.size)
    stack = np.stack([values[i - window + 1: i + 1] for i in idx], axis=1)  # (window, n)
    x = np.arange(window, dtype=np.float64)
    fit = ols_trend(x, stack, min_fraction=2 / 3)
    slope[idx] = fit["slope"] * 10
    half[idx] = fit["ci"] * 10
    return slope, half


def _series_stats(years: np.ndarray, values: np.ndarray, start_y: int, end_y: int,
                  base: tuple[int, int]) -> dict[str, Any]:
    sel = (years >= start_y) & (years <= end_y)
    x = years[sel].astype(np.float64)
    y = values[sel]
    ok = np.isfinite(y)
    result: dict[str, Any] = {"n_years": int(ok.sum())}
    fit = ols_trend(x, y[:, None], min_fraction=0.5)
    slope = float(fit["slope"][0])
    if not math.isfinite(slope):
        result["error"] = "Zu wenige Jahre mit Daten im gewählten Zeitraum"
        return result
    ci = float(fit["ci"][0])
    result.update({
        "trend": _num(slope * 10), "trend_ci": _num(ci * 10), "trend_p": _num(fit["p"][0], 6),
        "r1": _num(fit["r1"][0], 3), "n_eff": _num(fit["n_eff"][0], 1),
        "change": _num(slope * (end_y - start_y), 3),
        "intercept": _num(fit["intercept"][0]), "x_mean": _num(fit["x_mean"][0]),
        "resid_std": _num(fit["resid_std"][0]),
        "snr": _num(slope * (end_y - start_y) / float(fit["resid_std"][0]), 2),
    })
    xs, ys = x[ok], y[ok]
    if xs.size >= MIN_YEARS:
        sen = stats.theilslopes(ys, xs)
        tau = stats.kendalltau(xs, ys)
        result.update({
            "sen": _num(sen.slope * 10), "sen_lo": _num(sen.low_slope * 10), "sen_hi": _num(sen.high_slope * 10),
            "mk_tau": _num(tau.statistic, 3), "mk_p": _num(tau.pvalue, 6),
        })
        mid = (start_y + end_y) // 2
        first = ols_trend(x[x <= mid], y[x <= mid][:, None], 0.5)
        second = ols_trend(x[x > mid], y[x > mid][:, None], 0.5)
        accel = (float(second["slope"][0]) - float(first["slope"][0])) * 10
        accel_se = math.sqrt(float(first["se"][0]) ** 2 + float(second["se"][0]) ** 2) * 10
        result.update({
            "trend_first_half": _num(float(first["slope"][0]) * 10),
            "trend_second_half": _num(float(second["slope"][0]) * 10),
            "halves": [[start_y, mid], [mid + 1, end_y]],
            "acceleration": _num(accel),
            "acceleration_significant": bool(math.isfinite(accel) and abs(accel) > 1.96 * accel_se),
        })
        last10 = ys[xs > end_y - 10]
        result["mean_last10"] = _num(last10.mean(), 3) if last10.size >= 5 else None
        order = np.argsort(ys)[::-1]
        result["warmest"] = [[int(xs[i]), _num(ys[i], 2)] for i in order[:3]]
        result["coldest"] = [[int(xs[i]), _num(ys[i], 2)] for i in order[::-1][:3]]
    # Time of emergence against the year-to-year noise of the baseline period.
    bsel = (years >= base[0]) & (years <= base[1]) & np.isfinite(values)
    if bsel.sum() >= 15:
        base_years = years[bsel].astype(np.float64)
        base_vals = values[bsel]
        detr = base_vals - np.polyval(np.polyfit(base_years, base_vals, 1), base_years)
        noise = float(detr.std(ddof=1))
        ref = float(base_vals.mean())
        run = _running_mean(values)
        valid_idx = np.nonzero(np.isfinite(run))[0]
        sign = np.sign(run[valid_idx[-1]] - ref) if valid_idx.size else 1.0
        above = np.isfinite(run) & (sign * (run - ref) > 2 * noise)
        toe = None
        if valid_idx.size and above[valid_idx[-1]]:
            k = valid_idx.size - 1
            while k > 0 and above[valid_idx[k - 1]]:
                k -= 1
            toe = int(years[valid_idx[k]])
        result["noise_std"] = _num(noise, 3)
        result["emergence_year"] = toe
    return result


def season_clim(ds: GriddedDataset, season: str) -> np.ndarray:
    """Absolute climatology of the season's months (falls back to the annual mean)."""
    if ds.clim_monthly is None:
        return ds.clim
    _, months = season_spec(season)
    return np.nanmean(ds.clim_monthly[[m - 1 for m in months]], axis=0)


def _region_clim(ds: GriddedDataset, weights: np.ndarray, season: str = "annual") -> float | None:
    clim = season_clim(ds, season)
    ok = np.isfinite(clim) & (weights > 0)
    if not ok.any():
        return None
    return float((clim[ok] * weights[ok]).sum() / weights[ok].sum())


def _monthly_trends(ds: GriddedDataset, weights: np.ndarray, start_y: int, end_y: int) -> list[dict[str, Any]]:
    years, cube = _monthly_cube(ds)
    sel = (years >= start_y) & (years <= end_y)
    out = []
    flat = cube[sel]  # (y, 12, lat, lon)
    for m in range(12):
        series, _ = _area_mean(flat[:, m], weights)
        fit = ols_trend(years[sel].astype(np.float64), series[:, None], min_fraction=0.5)
        out.append({
            "month": MONTH_NAMES[m],
            "trend": _num(float(fit["slope"][0]) * 10),
            "ci": _num(float(fit["ci"][0]) * 10),
            "p": _num(float(fit["p"][0]), 5),
        })
    return out


def region_series(ds: GriddedDataset, regions: Sequence[Region], start: Any = None, end: Any = None,
                  season: str = "annual", baseline: str | None = None,
                  include_series: bool = True) -> dict[str, Any]:
    """Area-weighted anomaly series and trend statistics for each region."""
    years, grid = seasonal_grid(ds, season, baseline)
    start_y, end_y, _ = _period(years, start, end)
    base = _baseline(baseline, ds) or tuple(ds.baseline)
    global_values, _ = _area_mean(grid, region_weights(ds, PRESETS_BY_ID["global"]))
    global_stats = _series_stats(years, global_values, start_y, end_y, base)
    results = []
    for region in regions:
        weights = region_weights(ds, region)
        values, coverage = _area_mean(grid, weights)
        info = region.to_dict()
        info["cells"] = int(np.count_nonzero(weights))
        info["area_km2"] = round(region_area_km2(ds, weights))
        stats_ = _series_stats(years, values, start_y, end_y, base)
        g = global_stats.get("trend")
        if stats_.get("trend") is not None and g and ds.kind == "temperature":
            stats_["vs_global"] = _num(stats_["trend"] / g, 2)
        if stats_.get("trend") is not None and ds.clim is not None:
            clim = _region_clim(ds, weights, season)
            if clim and clim > 0.05:
                stats_["clim"] = _num(clim, 3)
                stats_["trend_rel"] = _num(stats_["trend"] / clim * 100, 2)
                stats_["trend_rel_ci"] = _num((stats_.get("trend_ci") or 0) / clim * 100, 2)
        info["stats"] = stats_
        if include_series:
            info["values"] = _round_list(values, 3)
            info["coverage"] = _round_list(coverage, 2)
            info["running"] = _round_list(_running_mean(values), 3)
            info["monthly_trends"] = _monthly_trends(ds, weights, start_y, end_y)
            roll, roll_ci = rolling_trend(years, values)
            info["rolling_trend"] = _round_list(roll, 3)
            info["rolling_ci"] = _round_list(roll_ci, 3)
        results.append(info)
    return {
        "years": [int(y) for y in years] if include_series else None,
        "period": [start_y, end_y],
        "season": season,
        "season_label": season_spec(season)[0],
        "baseline": list(base),
        "global": {"trend": global_stats.get("trend"), "trend_ci": global_stats.get("trend_ci")},
        "rolling_window": ROLLING_WINDOW,
        "regions": results,
    }


def ranking(ds: GriddedDataset, start: Any = None, end: Any = None, season: str = "annual",
            baseline: str | None = None) -> dict[str, Any]:
    """Trend statistics of every preset region, fastest warming first."""
    data = region_series(ds, PRESET_REGIONS, start, end, season, baseline, include_series=False)
    rows = []
    for region in data["regions"]:
        s = region["stats"]
        rows.append({
            "id": region["id"], "name": region["name"], "group": region["group"],
            "trend": s.get("trend"), "trend_ci": s.get("trend_ci"), "trend_p": s.get("trend_p"),
            "vs_global": s.get("vs_global"), "change": s.get("change"),
            "acceleration": s.get("acceleration"), "emergence_year": s.get("emergence_year"),
            "snr": s.get("snr"), "trend_rel": s.get("trend_rel"),
        })
    rows.sort(key=lambda r: -(r["trend"] if r["trend"] is not None else -1e9))
    data["rows"] = rows
    del data["regions"]
    return data


def zonal(ds: GriddedDataset, season: str = "annual", baseline: str | None = None) -> dict[str, Any]:
    """Zonal-mean anomaly per latitude band and year (Hovmöller diagram)."""
    years, grid = seasonal_grid(ds, season, baseline)
    count = np.isfinite(grid).sum(axis=2)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)
        mean = np.nanmean(grid, axis=2)
    mean[count < ds.lons.size * 0.25] = np.nan  # less than a quarter of the circle measured
    return {
        "years": [int(y) for y in years],
        "lats": [float(v) for v in ds.lats],
        "values": _round_list(mean, 2),  # [year][lat] flattened
        "season_label": season_spec(season)[0],
    }


DIST_BINS = np.arange(-6.0, 12.0001, 0.25)


def distribution(ds: GriddedDataset, region: Region, season: str = "JJA",
                 baseline: str | None = None, periods: Sequence[tuple[int, int]] | None = None) -> dict[str, Any]:
    """Shift of the local anomaly distribution (cf. Hansen, Sato & Ruedy 2012, PNAS 109, E2415).

    Every cell-year of the region is standardised with the cell's own baseline
    mean and year-to-year standard deviation (detrended within the baseline).
    The histogram per period shows how often seasons that were ±1σ, ±2σ, ±3σ
    rare in the baseline occur now (area-weighted).
    """
    years, grid = seasonal_grid(ds, season, None)
    base = _baseline(baseline, ds) or tuple(ds.baseline)
    weights = region_weights(ds, region)
    idx = np.nonzero(weights)
    w = weights[idx]
    vals = grid[(slice(None),) + idx].astype(np.float64)  # (years, cells)
    bsel = (years >= base[0]) & (years <= base[1])
    bvals = vals[bsel]
    bx = years[bsel].astype(np.float64)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)
        fit = ols_trend(bx, bvals, min_fraction=2 / 3)
        resid = bvals - (fit["intercept"] + fit["slope"] * (bx[:, None] - fit["x_mean"]))
        sigma = np.sqrt(np.nansum(resid**2, axis=0) / np.maximum(np.isfinite(resid).sum(axis=0) - 2, 1))
        mean = np.nanmean(bvals, axis=0)
    ok = np.isfinite(sigma) & (sigma > 0) & np.isfinite(mean)
    z = (vals[:, ok] - mean[ok]) / sigma[ok]
    w = w[ok]
    last = int(years[-1])
    if periods is None:
        # The reference period, then the years after it in (up to) three equal parts.
        after = last - base[1]
        parts = 3 if after >= 30 else 2 if after >= 12 else 1
        size = after / parts if after > 0 else 0
        periods = [(base[0], base[1])]
        for k in range(parts):
            a = base[1] + 1 + round(k * size)
            b = base[1] + round((k + 1) * size)
            if b >= a:
                periods.append((a, b))
    out_periods = []
    for a, b in periods:
        sel = (years >= a) & (years <= b)
        if not sel.any() or not ok.any():
            continue
        zz = z[sel]
        ww = np.broadcast_to(w, zz.shape)
        m = np.isfinite(zz)
        if m.sum() == 0:
            continue
        zc = np.clip(zz[m], DIST_BINS[0], DIST_BINS[-1] - 1e-9)
        hist, _ = np.histogram(zc, bins=DIST_BINS, weights=ww[m])
        total = ww[m].sum()
        dens = hist / total / (DIST_BINS[1] - DIST_BINS[0])
        out_periods.append({
            "period": [a, min(b, last)],
            "density": _round_list(dens, 4),
            "mean": _num(np.average(zz[m], weights=ww[m]), 3),
            "above2": _num(ww[m][zz[m] > 2].sum() / total, 4),
            "above3": _num(ww[m][zz[m] > 3].sum() / total, 4),
            "below_m2": _num(ww[m][zz[m] < -2].sum() / total, 4),
        })
    return {
        "region": region.to_dict(),
        "season": season,
        "season_label": season_spec(season)[0],
        "baseline": list(base),
        "bins": [float(v) for v in DIST_BINS],
        "cells": int(ok.sum()),
        "periods": out_periods,
    }
