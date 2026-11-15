# TrendDetective

Be An Earth System Trend Detective!

## Run the website

```bash
python3 app.py
```

Open http://127.0.0.1:8000. Choose a time frame, an interval and topics in the sidebar, pick a
point on the world map with the 📍 tool (or one of the predefined regions with **Areas**), and
click **Apply**. To move a point, switch on **Edit** in the map toolbar first.

When a result card has no values (for example because the stations nearby stopped reporting
before the chosen time frame), the card shows when the stations around the point or in the
region do have data: stations per year, the longest-running stations, and a button that fills in
a time frame with data. This comes from the station metadata of the NOAA Search Service
(`POST /api/coverage`, see [`station_coverage.py`](station_coverage.py)); no observations are
downloaded for it.

## Famous events, notable events and the analysis tools

**Explore a famous event** (top of the page, [`examples.py`](examples.py), `GET /api/examples`):
eleven well-known events, e.g. the 2021 Pacific Northwest heat dome, the Berlin cloudburst of
29 June 2017 or Hurricane Harvey. One click fills in the form, runs the request and zooms the
plot to the day. Every example was checked against the data the app delivers.

**Notable events** ([`events.py`](events.py)): every result carries `events`, the values that
stand out most from the *normal of their time of year* (mean of the same calendar days over all
years), the records of the time range and the strongest warm / cold spells. The plot marks them
with numbers, the list below the plot explains each one, and *Satellite image* shows the NASA
MODIS true-colour image of that day on the map (NASA GIBS tiles, available since 24 Feb 2000).

**Analysis tools** ([`src/task.py`](src/task.py), [`plot_analysis.py`](plot_analysis.py)):

| Tool | Answers |
|---|---|
| Linear regression | average change per year / decade |
| Sen's slope | the same, but robust to single extremes (median of all pairwise slopes) |
| Mann-Kendall | does the series keep rising or falling? |
| Change point (Pettitt) | when did the level shift most clearly? |
| t-Test | is the second half different from the first? |

Daily climate data is autocorrelated (a warm day follows a warm day), so the textbook p-values
would call almost any wiggle "significant". All tools therefore correct their significance:
regression and t-test use the effective sample size `n(1-r1)/(1+r1)` (Santer et al. 2000),
Mann-Kendall and Sen's slope the variance correction of Hamed & Rao (1998), the change point
test an AR(1) scaling; the autocorrelation is estimated without the seasonal cycle, and the
change point test removes the seasonal cycle first. `p_value_unadjusted` keeps the textbook value.

The plot panel adds a plain-language summary of the trend, and a **Stripes** view (one coloured
stripe per year, the departure of its mean from the mean of all years).

## Global Explorer (globale Trends vergleichen)

Open http://127.0.0.1:8000/explorer/ for a globe-first view built on gridded data – the NASA
GISTEMP v4 temperature grid (2°, monthly since 1880) and GPCP v2.3 precipitation (2.5°, since
1979): maps of warming trend, anomaly, acceleration,
signal-to-noise and spatial gradient, a year-by-year animation, and side-by-side comparison
of any regions (presets such as Mediterranean, Antarctica, South Pacific, NRW; place search;
drawn rectangles; single grid cells). Each dataset (~21–26 MB) is downloaded on first use into
`data/cache/`. Concept, methods and an analysis of the station-based tool:
[docs/global-explorer.md](docs/global-explorer.md).

```bash
python -m unittest tests.test_global_analysis
```

## Map widget

The world map is the widget in [`map-widget/`](map-widget/), built into [`static/map-widget/`](static/map-widget/).

- [map-widget/API.md](map-widget/API.md) – how the page uses the widget (what it needs, what it delivers)
- [map-widget/DEVELOPMENT.md](map-widget/DEVELOPMENT.md) – how the widget works internally

After changing widget code, rebuild the bundle and commit `static/map-widget/`:

```bash
cd map-widget && npm install && npm run build:embed
```

## Fetch weather and climate observations from NOAA NCEI

The NOAA provider uses the NCEI Access Search and Data Services and requires
no API token. It finds matching stations in a small bounding box centered on
the selected coordinate, then downloads observations from the closest
matching station to `data/noaa/`. NOAA reports station measurements; it does
not interpolate a value at the exact point.

```bash
python -m pip install -r requirements.txt
```

```python
from datetime import date

from api_wrapper import PointDataRequest, fetch_data_single_topic_single_coordinate

request = PointDataRequest(
    latitude=38.8951,  # float: decimal degrees
    longitude=-77.0364,  # float: decimal degrees
    topic="precipitation",
    start_date=date(2020, 1, 1),
    end_date=date(2020, 1, 31),
)
# NOAA is the default. The provider keyword keeps the wrapper ready for
# additional API clients in the future.
measurement_iterators = fetch_data_single_topic_single_coordinate(request)
for measurement_iterator in measurement_iterators:
    for observation in measurement_iterator:
        print(observation)
```

`noaa_api.py` contains the curated `TOPICS` mapping from application topic
names to NCEI dataset slugs and case-sensitive data type codes. It covers
common daily, hourly, monthly, annual, and marine climate observations. See
the [NOAA topic catalog](docs/noaa-topics.rst).

List topic names from every registered API with
`get_all_topics_list()`. It returns unique names as a `list[str]`:

```python
from api_wrapper import get_all_topics_list

topic_names = get_all_topics_list()
print(topic_names)
```

Run the fixed live example with `python noaa_test.py`. It requests
temperature near Washington, DC from January through May 2020 and displays
the returned records. The function returns a list of iterators, one per
variable (for example, `tmax` and `tmin`). Each iterator yields date-by-date
records with shared lowercase station metadata keys, a numeric `value`, and a
lowercase `description` naming that variable. Iterators stream their records
from the nested JSON file saved under `data/noaa_test/`.

## Additional data sources

Besides NOAA, these sources are registered in `api_wrapper._PROVIDERS`. None
needs a registration or API key.

| Provider | Module | Coverage | Topics |
|---|---|---|---|
| DWD (German weather service, Open Data) | [`dwd_api.py`](dwd_api.py) | Germany, ~1,100 climate and ~6,600 precipitation stations | `temperature`, `precipitation`, `snowfall`, `snow_depth`, `wind_speed` |
| ECCC (Environment Canada, MSC GeoMet) | [`eccc_api.py`](eccc_api.py) | Canada | `temperature`, `precipitation`, `snowfall`, `snow_depth`, `wind_speed` (gusts) |
| FMI (Finnish Meteorological Institute) | [`fmi_api.py`](fmi_api.py) | Finland | `temperature`, `precipitation`, `snow_depth` |
| Open-Meteo (ERA5 reanalysis, a model) | [`openmeteo_api.py`](openmeteo_api.py) | world, 1940 to today | `temperature_era5`, `precipitation_era5`, `snowfall_era5`, `snow_depth_era5`, `wind_speed_era5`, `humidity_era5`, `dew_point_era5`, `pressure_era5`, `cloud_cover_era5`, `sunshine_era5`, `solar_radiation_era5`, `evapotranspiration_era5`, `soil_moisture_era5`, `soil_temperature_era5` |
| NOAA PolarWatch (VIIRS satellite) | [`polarwatch_api.py`](polarwatch_api.py) | polar seas and lakes, since 2021, point only | `ice_thickness_satellite` |

The station sources deliver NOAA's variable codes and units (`tmax`, `prcp`,
`snwd` in mm, wind in m/s), so their values join the same series as NOAA's.
ERA5 and satellite data have their own topics and are never mixed with
station measurements.

- **Point:** every source that covers the point is asked in parallel, and the
  station nearest to the point wins, whatever database it comes from. The
  result card names the source.
- **Region:** stations from all sources are merged. GHCN-Daily re-publishes
  many national stations, so copies are removed first
  (`station_sources.deduplicate`). Two stations are treated as the same when
  they share a WMO number, an ECCC climate ID (GHCN `CAN0xxxxxxx`) or a GHCN
  ID. WMO numbers for GHCN come from `ghcnd-stations.txt`, and for DWD from
  the Bright Sky API. Many German and Finnish GHCN stations carry only an
  ECA&D number, so stations of different databases standing within 1 km of
  each other (and 25 m in height) also count as one. Of two copies, the one
  covering more of the time frame is kept, and on a tie the national original
  wins. The card shows how many stations each source contributed and how many
  duplicates were removed.

Downloaded station lists and DWD files are cached in `data/cache/`.

## Add another provider

Provider clients implement the `PointDataProvider` protocol in
`api_wrapper.py`. Register a client class in `_PROVIDERS`, then callers can
select it with the `provider` keyword while NOAA remains the default. Station
databases can subclass `station_sources.StationSource`, which implements the
point request and is used by the region evaluation.

## Run the checks

```bash
.venv/bin/python -m unittest discover -s tests -p 'test_*.py'
.venv/bin/python -m unittest src.test_task
cd map-widget && npm run lint && npx tsc -b
```

The Python tests run offline. The map widget has no automated tests; see
`map-widget/DEVELOPMENT.md` §12 for the manual checklist.

## Build the API reference

The Sphinx documentation source is in `docs/`. Install the documentation
tools and build HTML with:

```bash
python -m pip install -r docs/requirements.txt
python -m sphinx -b html docs docs/_build/html
```
