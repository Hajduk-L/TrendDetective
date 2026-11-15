# TrendDetective

**Be An Earth System Trend Detective!** – Team Claudius, NASA Space Apps 2026.
Pitch deck: [docs/TrendDetective-Pitch.pdf](docs/TrendDetective-Pitch.pdf)

Missions and models provide hundreds of variables, one process can drive opposite trends in
neighbouring regions, and natural variability and autocorrelation can mimic a trend.
TrendDetective lets you pick a location and a variable, gives a filtered overview of what has
changed, and quantifies every trend with significance tests that account for autocorrelation.

## Quick start

Requires Python 3.11 or newer.

```bash
git clone https://github.com/EricL06/TrendDetective.git
cd TrendDetective
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
.venv/bin/python app.py
```

On Windows use `.venv\Scripts\python` instead of `.venv/bin/python`. The install is large
(about 900 MB, mostly PyTorch) and takes a few minutes the first time.

Open http://127.0.0.1:8000. No API keys are needed. A first-visit tour and the **?** button
explain the page.

1. **Select a location** – a point (📍), a box or a predefined region. The nearest station is
   used, or a station of your choice, or ERA5 reanalysis.
2. **Select variables and a period** – nine variable groups, records back to 1950.
3. **Analyze** – an overview of the key findings; full statistics on demand.

**Famous events** load documented extremes as ready-made examples (2021 Pacific Northwest heat
dome, Berlin cloudburst 2017, Hurricane Harvey, …).

*Example – London Heathrow, daily air temperature 1950–2025:* warming of +0.30 °C per decade
(p < 0.001), 2020s vs 1950s +2.1 °C, a level shift of +1.3 °C around 1989, station vs ERA5
r = +0.99.

## What the analysis does

| Tool | Answers |
|---|---|
| Linear regression, Sen's slope | change per decade (Sen's slope is robust to outliers) |
| Mann-Kendall | does the series keep rising or falling? |
| Pettitt change point | when did the level shift? |
| t-test | is the second half different from the first? |
| Notable events | records, warm/cold spells and outliers vs the seasonal normal, with NASA MODIS satellite images (since 2000) |
| Comparison | correlation, overlaid years, anomalies, stripes, CSV export |

Daily climate data is autocorrelated, so textbook p-values would call almost any wiggle
significant. Regression and t-test use the effective sample size (Santer et al. 2000),
Mann-Kendall and Sen's slope the Hamed & Rao (1998) correction, Pettitt an AR(1) scaling; the
seasonal cycle is removed first. Code: [`src/task.py`](src/task.py),
[`plot_analysis.py`](plot_analysis.py), [`events.py`](events.py).

## Data sources

All sources are free and need no registration. Stations from different databases are merged
and de-duplicated ([`station_sources.py`](station_sources.py)); for a point the nearest station
wins, whatever source it comes from. Downloads are cached in `data/cache/`.

| Source | Module | Coverage |
|---|---|---|
| NOAA NCEI (GHCN-Daily and more) | [`noaa_api.py`](noaa_api.py) | world, stations |
| DWD | [`dwd_api.py`](dwd_api.py) | Germany, stations |
| Environment Canada (ECCC) | [`eccc_api.py`](eccc_api.py) | Canada, stations |
| FMI | [`fmi_api.py`](fmi_api.py) | Finland, stations |
| Open-Meteo (ERA5 reanalysis) | [`openmeteo_api.py`](openmeteo_api.py) | world, 1940–today, model |
| NOAA PolarWatch (VIIRS) | [`polarwatch_api.py`](polarwatch_api.py) | polar sea/lake ice thickness, since 2021 |

ERA5 and satellite data keep their own topics and are never mixed with station measurements.
To add a provider, implement the `PointDataProvider` protocol in
[`api_wrapper.py`](api_wrapper.py) and register it in `_PROVIDERS` (station databases can
subclass `station_sources.StationSource`).

## Global Explorer (prototype)

A globe built on gridded data – NASA GISTEMP v4 temperature and GPCP v2.3 precipitation – with
trend, anomaly and signal-to-noise maps, a year-by-year animation and region comparison. It is
not linked from the main page yet; open http://127.0.0.1:8000/explorer/ directly. Details:
[docs/global-explorer.md](docs/global-explorer.md).

**Next steps:** release the Global Explorer in the main app; more NASA data (MERRA-2, GLDAS,
GPM, AIRS); link a gridded hot spot to the station records behind it; ocean and upper-air
trends.

## Project layout

| Path | Content |
|---|---|
| `app.py` | HTTP server and `/api/*` routes |
| `api_wrapper.py`, `*_api.py`, `station_sources.py` | data providers |
| `area_analysis.py`, `plot_analysis.py`, `correlation.py`, `evolution.py`, `events.py`, `src/task.py` | analysis |
| `index.html`, `static/` | website |
| `map-widget/` | map (React + MapLibre), built into `static/map-widget/` – see [API.md](map-widget/API.md), [DEVELOPMENT.md](map-widget/DEVELOPMENT.md) |
| `explorer/`, `global_*.py` | Global Explorer |
| `tests/`, `docs/` | unit tests, Sphinx API reference and UML |

## Development

```bash
.venv/bin/python -m unittest discover -s tests -p 'test_*.py'   # offline tests
.venv/bin/python -m unittest src.test_task
cd map-widget && npm install && npm run build:embed              # after map widget changes
python -m sphinx -b html docs docs/_build/html                   # API reference (docs/requirements.txt)
```
