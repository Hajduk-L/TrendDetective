"""Gridded global temperature data for the Global Explorer.

The station pipeline of TrendDetective (``api_wrapper``/``area_analysis``) asks
weather services for measurements around one point or region at a time. To
compare *any* regions of the planet with each other in seconds, the explorer
uses a gridded, quality-controlled analysis product instead:

**NASA GISTEMP v4** (GHCNv4 land stations + ERSSTv5 ocean), monthly surface
temperature anomalies on a 2° × 2° grid since January 1880, relative to the
1951–1980 mean. Each grid value is interpolated by NASA from the stations
within 1200 km; cells without a station in reach stay empty (NaN). No key or
registration is needed; the file (~26 MB gzip) is downloaded once into
``data/cache/gistemp/``.

A second grid, **GPCP v2.3** monthly precipitation (2.5°, since 1979, NOAA PSL),
is fetched in ten-year pieces from the THREDDS NetCDF Subset Service as
netCDF3 (the original file is HDF5, which scipy cannot read) and cached as a
compact ``.npz``. Precipitation anomalies are taken against the 1991–2020
monthly climatology, which is kept to express trends in percent.

Citation: GISTEMP Team (2026): GISS Surface Temperature Analysis (GISTEMP),
version 4. NASA Goddard Institute for Space Studies.
Lenssen et al. (2019), J. Geophys. Res. Atmos., 124, 6307–6326.
"""

from __future__ import annotations

import gzip
import io
import shutil
import threading
import time
from dataclasses import dataclass, field
from datetime import date, timedelta
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import numpy as np
from scipy.io import netcdf_file

BASE_DIR: Path = Path(__file__).resolve().parent
CACHE_DIR: Path = BASE_DIR / "data" / "cache" / "gistemp"
GISTEMP_URL: str = "https://data.giss.nasa.gov/pub/gistemp/gistemp1200_GHCNv4_ERSSTv5.nc.gz"
GISTEMP_FILE: Path = CACHE_DIR / "gistemp1200_GHCNv4_ERSSTv5.nc"
USER_AGENT: str = "TrendDetective/0.1 (climate trend explorer)"


@dataclass
class GriddedDataset:
    """Monthly anomaly grid ``values[time, lat, lon]`` (float32, NaN = no data)."""

    key: str
    name: str
    variable: str
    unit: str
    baseline: tuple[int, int]
    citation: str
    url: str
    lats: np.ndarray  # cell centres, ascending (south → north)
    lons: np.ndarray  # cell centres, ascending (-180 → 180)
    years: np.ndarray  # year of each time step
    months: np.ndarray  # month (1–12) of each time step
    values: np.ndarray
    created: str = ""
    kind: str = "temperature"  # or "precipitation"
    clim: np.ndarray | None = None  # absolute annual-mean climatology (for relative trends)
    clim_monthly: np.ndarray | None = None  # absolute climatology per calendar month (12, lat, lon)
    baselines: tuple[str, ...] = ("1951-1980", "1961-1990", "1981-2010", "1991-2020", "1880-1900")
    resolution: str = "2°"
    _annual_cache: dict = field(default_factory=dict, repr=False)

    @property
    def lat_step(self) -> float:
        return float(abs(self.lats[1] - self.lats[0]))

    @property
    def lon_step(self) -> float:
        return float(abs(self.lons[1] - self.lons[0]))

    @property
    def first_year(self) -> int:
        return int(self.years[0])

    @property
    def last_month(self) -> tuple[int, int]:
        return int(self.years[-1]), int(self.months[-1])

    def meta(self) -> dict:
        """JSON-ready description of the grid and its provenance."""
        last_year, last_month = self.last_month
        return {
            "key": self.key,
            "kind": self.kind,
            "resolution": self.resolution,
            "relative": self.clim is not None,
            "name": self.name,
            "variable": self.variable,
            "unit": self.unit,
            "baseline": list(self.baseline),
            "citation": self.citation,
            "url": self.url,
            "created": self.created,
            "grid": {
                "lat_step": self.lat_step,
                "lon_step": self.lon_step,
                "nlat": int(self.lats.size),
                "nlon": int(self.lons.size),
                "lat0": float(self.lats[0]),
                "lon0": float(self.lons[0]),
            },
            "first": [int(self.years[0]), int(self.months[0])],
            "last": [last_year, last_month],
        }


_lock = threading.Lock()


def _download(url: str, target: Path) -> None:
    """Download a gzip file and unpack it to ``target`` (atomically)."""
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp_gz = target.with_suffix(".nc.gz.part")
    tmp_nc = target.with_suffix(".nc.part")
    request = Request(url, headers={"User-Agent": USER_AGENT})
    with urlopen(request, timeout=120) as response, tmp_gz.open("wb") as out:
        shutil.copyfileobj(response, out)
    with gzip.open(tmp_gz, "rb") as src, tmp_nc.open("wb") as out:
        shutil.copyfileobj(src, out)
    tmp_nc.replace(target)
    tmp_gz.unlink(missing_ok=True)


def _decode_time(days: np.ndarray, units: str) -> tuple[np.ndarray, np.ndarray]:
    """Turn ``days since YYYY-MM-DD`` into year and month arrays."""
    origin_text = units.split("since", 1)[1].strip().split()[0]
    y, m, d = (int(part) for part in origin_text.split("T")[0].split("-")[:3])
    origin = date(y, m, d)
    stamps = [origin + timedelta(days=int(d)) for d in days]
    return (
        np.array([s.year for s in stamps], dtype=np.int32),
        np.array([s.month for s in stamps], dtype=np.int32),
    )


def load_gistemp(path: Path = GISTEMP_FILE) -> GriddedDataset:
    """Read the GISTEMP netCDF3 file into a :class:`GriddedDataset`."""
    with netcdf_file(str(path), "r", mmap=False) as nc:
        lats = np.asarray(nc.variables["lat"][:], dtype=np.float64)
        lons = np.asarray(nc.variables["lon"][:], dtype=np.float64)
        time_var = nc.variables["time"]
        years, months = _decode_time(time_var[:], time_var.units.decode())
        var = nc.variables["tempanomaly"]
        raw = np.asarray(var[:])
        fill = var._attributes.get("_FillValue", 32767)
        scale = float(var._attributes.get("scale_factor", 1.0))
        values = raw.astype(np.float32) * np.float32(scale)
        values[raw == fill] = np.nan
        history = nc._attributes.get("history", b"").decode(errors="ignore")
    lat_order = np.argsort(lats)
    lon_order = np.argsort(lons)
    values = values[:, lat_order][:, :, lon_order]
    created = history.split("Created", 1)[1].split("by")[0].strip() if "Created" in history else ""
    return GriddedDataset(
        key="gistemp",
        name="NASA GISTEMP v4 (GHCNv4 + ERSSTv5)",
        variable="Oberflächentemperatur-Anomalie",
        unit="°C",
        baseline=(1951, 1980),
        citation=(
            "GISTEMP Team (2026): GISS Surface Temperature Analysis, v4. NASA GISS. "
            "Lenssen et al. (2019), JGR Atmospheres 124, 6307–6326."
        ),
        url="https://data.giss.nasa.gov/gistemp/",
        lats=lats[lat_order],
        lons=lons[lon_order],
        years=years,
        months=months,
        values=values,
        created=created,
    )


GPCP_NCSS: str = "https://psl.noaa.gov/thredds/ncss/grid/Datasets/gpcp/precip.mon.mean.nc"
GPCP_CACHE: Path = BASE_DIR / "data" / "cache" / "gpcp" / "gpcp_v23_monthly.npz"
GPCP_FIRST_YEAR: int = 1979
GPCP_CLIM: tuple[int, int] = (1991, 2020)


def _fetch_gpcp_chunk(start: int, end: int) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray, str]:
    url = (f"{GPCP_NCSS}?var=precip&accept=netcdf3"
           f"&time_start={start}-01-01T00:00:00Z&time_end={end}-12-31T00:00:00Z")
    payload = b""
    for attempt in range(6):
        try:
            request = Request(url, headers={"User-Agent": USER_AGENT})
            with urlopen(request, timeout=180) as response:
                payload = response.read()
            break
        except HTTPError as exc:  # PSL rate-limits bursts (429) – wait and retry
            if exc.code not in (429, 502, 503) or attempt == 5:
                raise
            retry = exc.headers.get("Retry-After") if exc.headers else None
            time.sleep(float(retry) if retry and retry.isdigit() else 15 * (attempt + 1))
    with netcdf_file(io.BytesIO(payload), "r", mmap=False) as nc:
        lats = np.asarray(nc.variables["lat"][:], dtype=np.float64)
        lons = np.asarray(nc.variables["lon"][:], dtype=np.float64)
        time_var = nc.variables["time"]
        days = np.asarray(time_var[:], dtype=np.float64)
        units = time_var.units.decode()
        var = nc.variables["precip"]
        raw = np.asarray(var[:], dtype=np.float32)
        missing = var._attributes.get("missing_value")
    if missing is not None:
        raw[np.isclose(raw, np.float32(missing))] = np.nan
    raw[(raw < 0) | (raw > 1000)] = np.nan
    return lats, lons, days, raw, units


def _download_gpcp(target: Path = GPCP_CACHE) -> None:
    """Fetch GPCP in decade-sized pieces (large NCSS answers get cut off) and cache it."""
    from datetime import date as _date

    parts = []
    last = _date.today().year
    lats = lons = None
    units = ""
    for start in range(GPCP_FIRST_YEAR, last + 1, 10):
        lats, lons, days, raw, units = _fetch_gpcp_chunk(start, min(start + 9, last))
        if days.size:
            parts.append((days, raw))
        time.sleep(3)
    days = np.concatenate([p[0] for p in parts])
    values = np.concatenate([p[1] for p in parts])
    order = np.argsort(days)
    days, values = days[order], values[order]
    keep = np.concatenate([[True], np.diff(days) > 0])
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = target.with_suffix(".part.npz")
    np.savez_compressed(tmp, lats=lats, lons=lons, days=days[keep], values=values[keep], units=np.array(units))
    tmp.replace(target)


def load_gpcp(path: Path = GPCP_CACHE) -> GriddedDataset:
    """GPCP v2.3 monthly precipitation as anomalies against the 1991–2020 climatology."""
    with np.load(path) as npz:
        lats, lons, days = npz["lats"], npz["lons"], npz["days"]
        values = npz["values"].astype(np.float32)
        units = str(npz["units"])
    years, months = _decode_time(days, units)
    lons = ((lons + 180.0) % 360.0) - 180.0
    lat_order = np.argsort(lats)
    lon_order = np.argsort(lons)
    values = values[:, lat_order][:, :, lon_order]
    lats, lons = lats[lat_order], lons[lon_order]
    clim_sel = (years >= GPCP_CLIM[0]) & (years <= GPCP_CLIM[1])
    monthly_clim = np.stack([np.nanmean(values[clim_sel & (months == m)], axis=0) for m in range(1, 13)])
    anomalies = values - monthly_clim[months - 1]
    return GriddedDataset(
        key="gpcp",
        name="GPCP v2.3 Niederschlag (Satellit + Messnetz)",
        variable="Niederschlags-Anomalie",
        unit="mm/Tag",
        baseline=GPCP_CLIM,
        citation=(
            "Adler, R. et al. (2018): The Global Precipitation Climatology Project (GPCP) Monthly "
            "Analysis (New Version 2.3) and a Review of 2017 Global Precipitation. Atmosphere 9, 138. "
            "Daten: NOAA PSL, Boulder, Colorado, USA."
        ),
        url="https://psl.noaa.gov/data/gridded/data.gpcp.html",
        lats=lats,
        lons=lons,
        years=years,
        months=months,
        values=anomalies.astype(np.float32),
        kind="precipitation",
        clim=np.nanmean(monthly_clim, axis=0).astype(np.float32),
        clim_monthly=monthly_clim.astype(np.float32),
        baselines=("1991-2020", "1981-2010"),
        resolution="2,5°",
    )


def _load_gistemp_cached() -> GriddedDataset:
    if not GISTEMP_FILE.exists():
        _download(GISTEMP_URL, GISTEMP_FILE)
    return load_gistemp(GISTEMP_FILE)


def _load_gpcp_cached() -> GriddedDataset:
    if not GPCP_CACHE.exists():
        _download_gpcp(GPCP_CACHE)
    return load_gpcp(GPCP_CACHE)


DATASETS: dict[str, dict] = {
    "gistemp": {"label": "Temperatur", "loader": _load_gistemp_cached},
    "gpcp": {"label": "Niederschlag", "loader": _load_gpcp_cached},
}
_loaded: dict[str, GriddedDataset] = {}
_key_locks: dict[str, threading.Lock] = {}
_override: GriddedDataset | None = None


def get_dataset(key: str = "gistemp") -> GriddedDataset:
    """Return a loaded dataset, downloading it on first use."""
    if _override is not None:
        return _override
    if key not in DATASETS:
        raise KeyError(key)
    with _lock:  # one lock per dataset, so a long download does not block the others
        key_lock = _key_locks.setdefault(key, threading.Lock())
    with key_lock:
        if key not in _loaded:
            _loaded[key] = DATASETS[key]["loader"]()
        return _loaded[key]


def set_dataset(dataset: GriddedDataset | None) -> None:
    """Serve ``dataset`` for every key (tests with a synthetic grid); None restores normal loading."""
    global _override
    with _lock:
        _override = dataset
