# TrendDetective

Be An Earth System Trend Detective!

## Run the website

```bash
python3 app.py
```

Open http://127.0.0.1:8000. Choose a timestamp, an interval and topics in the sidebar, draw an
area on the world map (or pick a single point with the 📍 tool), and click **Apply**.
To move or reshape a selection, switch on **Edit** in the map toolbar first.

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

## Add another provider

Provider clients implement the `PointDataProvider` protocol in
`api_wrapper.py`. Register a client class in `_PROVIDERS`, then callers can
select it with the `provider` keyword while NOAA remains the default.

## Build the API reference

The Sphinx documentation source is in `docs/`. Install the documentation
tools and build HTML with:

```bash
python -m pip install -r docs/requirements.txt
python -m sphinx -b html docs docs/_build/html
```
