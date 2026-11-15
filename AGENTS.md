# AGENTS.md

Orientation for AI agents and new contributors. Keep it short and true.

## Layout

| Path | What it is |
|---|---|
| `app.py` | HTTP server (`ThreadingHTTPServer`) and the `/api/*` route table. Source of truth for which endpoints exist. |
| `interface.py`, `api_wrapper.py` | Request model and the provider-agnostic data wrapper. |
| `*_api.py`, `station_sources.py` | Data provider clients (NOAA, DWD, ECCC, FMI, Open-Meteo, PolarWatch) and shared station logic. |
| `area_analysis.py`, `plot_analysis.py`, `correlation.py`, `evolution.py`, `events.py` | Analysis behind the website. |
| `src/task.py` | Analysis tools (regression, Mann-Kendall, ...). |
| `index.html`, `static/` | Website frontend. `static/help.js` holds the "?" help dialog and the first-visit tour: update its steps when you move or rename controls. |
| `explorer/`, `global_*.py` | Global Explorer: gridded-data globe at `/explorer/`, API under `/api/global/`. |
| `map-widget/` | Map widget source (React + MapLibre). |
| `tests/`, `src/test_task.py` | Python unit tests (unittest). |
| `docs/` | Sphinx API reference. |

## Generated and pinned paths

- `static/map-widget/` is **generated** by `cd map-widget && npm run build:embed`. Never edit it by
  hand; change `map-widget/src/` and rebuild. It is a minified vendor bundle, so don't review it as source.
- `docs/uml/out/` is generated.
- `data/noaa_test/` holds pinned example data; regenerate only on purpose.
- `data/cache/`, `data/noaa/`, `docs/_build/` are runtime/build output and are git-ignored.
  Never commit runtime output or platform files (`.DS_Store`).

## Validate a change

```bash
.venv/bin/python -m unittest discover -s tests -p 'test_*.py'
.venv/bin/python -m unittest src.test_task
cd map-widget && npm run lint && npx tsc -b   # only when map-widget/ changed
```

To see the website, run `python3 app.py` (port 8000); `.claude/launch.json` has preview configs.

## Rules

- The server is multi-threaded: guard every module- or class-level cache with a lock.
- Docs must match the code: when you add or remove an `/api/*` route in `app.py`, update
  `README.md` and `map-widget/DEVELOPMENT.md` in the same change.
- More detail: `README.md`, `map-widget/API.md`, `map-widget/DEVELOPMENT.md`, `docs/`.
