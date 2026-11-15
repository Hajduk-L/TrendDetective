"""HTTP endpoints of the Global Explorer (``/api/global/...``).

All endpoints are stateless GET requests with query parameters, so answers can
be cached by the browser per URL:

* ``meta``                      dataset, grid, seasons, baselines, layers, presets
* ``layer?kind&start&end&season&baseline``   one map layer (flat grid)
* ``frames?season&baseline``    all yearly anomaly maps, binary int16 (1/100 °C)
* ``frames?res=monthly&from&to&baseline``  monthly maps (≤ 20 years per call)
* ``regions?ids=a,b&custom=<json>&start&end&season&baseline``  region comparison
* ``cell?lat&lon&...``          series of one 2° grid cell
* ``ranking?start&end&season&baseline``      trends of all preset regions
* ``zonal?season&baseline``     zonal means per latitude and year (Hovmöller)
* ``distribution?region&season&baseline``  shift of the standardised anomaly distribution
"""

from __future__ import annotations

import gzip
import importlib
import json
from pathlib import Path
from typing import Any, Callable
from urllib.parse import parse_qs

import global_analysis as ga
import global_data as gd

PREFIX = "/api/global/"
_ANALYSIS_FILE = Path(ga.__file__)
_analysis_mtime = _ANALYSIS_FILE.stat().st_mtime


def _reload_if_changed() -> None:
    """Pick up edits to ``global_analysis.py`` without restarting (like ``interface.py``)."""
    global _analysis_mtime, ga
    mtime = _ANALYSIS_FILE.stat().st_mtime
    if mtime != _analysis_mtime:
        ga = importlib.reload(ga)
        _analysis_mtime = mtime


def _q(params: dict[str, list[str]], key: str, default: Any = None) -> Any:
    values = params.get(key)
    return values[0] if values and values[0] != "" else default


def _common(params: dict[str, list[str]]) -> dict[str, Any]:
    return {
        "season": _q(params, "season", "annual"),
        "baseline": _q(params, "baseline"),
    }


def _period(params: dict[str, list[str]]) -> dict[str, Any]:
    out = {}
    for key in ("start", "end"):
        raw = _q(params, key)
        if raw is not None:
            try:
                out[key] = int(raw)
            except ValueError as exc:
                raise ga.AnalysisInputError(f"{key} muss eine Jahreszahl sein") from exc
    return out


def _meta(ds: gd.GriddedDataset, params: dict[str, list[str]]) -> dict[str, Any]:
    return {
        "dataset": ds.meta(),
        "datasets": [{"id": k, "label": v["label"]} for k, v in gd.DATASETS.items()],
        "seasons": [{"id": k, "label": v[0]} for k, v in ga.SEASONS.items()]
        + [{"id": f"m{i + 1:02d}", "label": name} for i, name in enumerate(ga.MONTH_NAMES)],
        "baselines": [{"id": k, "label": f"{a}–{b}"} for k, (a, b) in ga.BASELINES.items()
                      if k in ds.baselines or ds.key not in gd.DATASETS],
        "layers": [{"id": k, **v} for k, v in ga.layer_info(ds).items()],
        "presets": [r.to_dict() for r in ga.PRESET_REGIONS],
    }


def _regions(ds: gd.GriddedDataset, params: dict[str, list[str]]) -> dict[str, Any]:
    specs: list[Any] = [i for i in (_q(params, "ids", "") or "").split(",") if i]
    custom = _q(params, "custom")
    if custom:
        try:
            parsed = json.loads(custom)
        except json.JSONDecodeError as exc:
            raise ga.AnalysisInputError("custom ist kein gültiges JSON") from exc
        specs.extend(parsed if isinstance(parsed, list) else [parsed])
    if not specs:
        raise ga.AnalysisInputError("Keine Region gewählt")
    if len(specs) > 12:
        raise ga.AnalysisInputError("Höchstens 12 Regionen gleichzeitig")
    regions = [ga.parse_region(s) for s in specs]
    return ga.region_series(ds, regions, **_period(params), **_common(params))


def _cell(ds: gd.GriddedDataset, params: dict[str, list[str]]) -> dict[str, Any]:
    lat = ga._float(_q(params, "lat"), "lat")
    lon = ga._float(_q(params, "lon"), "lon")
    region = ga.parse_region({"point": [lon, lat], "name": f"Zelle {lat:.1f}°, {lon:.1f}°"})
    return ga.region_series(ds, [region], **_period(params), **_common(params))


def _distribution(ds: gd.GriddedDataset, params: dict[str, list[str]]) -> dict[str, Any]:
    raw = _q(params, "region")
    if not raw:
        raise ga.AnalysisInputError("region fehlt")
    try:
        spec = json.loads(raw) if raw.startswith("{") else raw
    except json.JSONDecodeError as exc:
        raise ga.AnalysisInputError("region ist kein gültiges JSON") from exc
    return ga.distribution(ds, ga.parse_region(spec), _q(params, "season", "JJA"), _q(params, "baseline"))


_JSON_ROUTES: dict[str, Callable[[gd.GriddedDataset, dict[str, list[str]]], Any]] = {
    "meta": _meta,
    "layer": lambda ds, p: ga.layer(ds, _q(p, "kind", "trend"), **_period(p), **_common(p)),
    "regions": _regions,
    "cell": _cell,
    "ranking": lambda ds, p: ga.ranking(ds, **_period(p), **_common(p)),
    "zonal": lambda ds, p: ga.zonal(ds, **_common(p)),
    "distribution": _distribution,
}


def _send_binary(handler: Any, payload: bytes, headers: dict[str, str]) -> None:
    """Binary answer, gzip-compressed when the client accepts it (frames are a few MB)."""
    request_headers = getattr(handler, "request_headers", None) or getattr(handler, "headers", None) or {}
    if "gzip" in (request_headers.get("Accept-Encoding") or ""):
        payload = gzip.compress(payload, compresslevel=4)
        headers = {**headers, "Content-Encoding": "gzip"}
    handler.send_response(200)
    handler.send_header("Content-Type", "application/octet-stream")
    handler.send_header("Content-Length", str(len(payload)))
    for key, value in headers.items():
        handler.send_header(key, value)
    handler.end_headers()
    handler.wfile.write(payload)


def handle_get(handler: Any, path: str, query: str) -> bool:
    """Answer ``/api/global/...``; return False for other paths."""
    if not path.startswith(PREFIX):
        return False
    name = path[len(PREFIX):].strip("/")
    params = parse_qs(query)
    _reload_if_changed()
    try:
        key = _q(params, "ds", "gistemp")
        try:
            ds = gd.get_dataset(key)
        except KeyError:
            raise ga.AnalysisInputError(f"Unbekannter Datensatz: {key}") from None
        if name == "frames":
            headers = {"X-Grid": f"{ds.lats.size}x{ds.lons.size}"}
            if _q(params, "res") == "monthly":
                (y0, m0), count, payload = ga.monthly_frames(
                    ds, _q(params, "from"), _q(params, "to"), _q(params, "baseline"))
                headers.update({"X-Start": f"{y0}-{m0:02d}", "X-Count": str(count)})
            else:
                years, payload = ga.frames(ds, **_common(params))
                headers["X-Years"] = f"{years[0]}-{years[-1]}"
            _send_binary(handler, payload, headers)
            return True
        route = _JSON_ROUTES.get(name)
        if route is None:
            handler._send_json(404, {"error": f"Unbekannter Endpunkt: {name}"})
            return True
        handler._send_json(200, route(ds, params))
    except ga.AnalysisInputError as exc:
        handler._send_json(400, {"error": str(exc)})
    except (OSError, ValueError, TypeError, KeyError) as exc:  # download or file broken
        handler._send_json(502, {"error": f"Datensatz nicht verfügbar: {exc}"})
    return True
