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
| Open-Meteo (ERA5 reanalysis, a model) | [`openmeteo_api.py`](openmeteo_api.py) | world, 1940 to today | `temperature_era5`, `precipitation_era5`, `snowfall_era5`, `snow_depth_era5`, `wind_speed_era5` |
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

## Build the API reference

The Sphinx documentation source is in `docs/`. Install the documentation
tools and build HTML with:

```bash
python -m pip install -r docs/requirements.txt
python -m sphinx -b html docs docs/_build/html
```
