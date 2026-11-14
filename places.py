"""Look up cities and regions by name (``GET /api/places?q=...``).

Uses the OpenStreetMap Nominatim search service. Its usage policy asks for at most
one request per second and an identifying User-Agent, so requests are serialised,
spaced out and cached in memory.
"""
from __future__ import annotations

import json
import threading
import time
from typing import Any
from urllib.error import URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

NOMINATIM_URL = "https://nominatim.openstreetmap.org/search"
USER_AGENT = "TrendDetective/0.1 (climate trend explorer)"
MIN_INTERVAL_S = 1.0
TIMEOUT_S = 10
MAX_RESULTS = 8
MAX_QUERY_LEN = 120

_lock = threading.Lock()
_last_request = 0.0
_cache: dict[str, list[dict[str, Any]]] = {}


def _to_place(item: dict[str, Any]) -> dict[str, Any] | None:
    """Convert one Nominatim result into ``{name, label, kind, lat, lon, bbox}``."""
    try:
        lat = float(item["lat"])
        lon = float(item["lon"])
        south, north, west, east = (float(v) for v in item["boundingbox"])
    except (KeyError, TypeError, ValueError):
        return None
    label = item.get("display_name") or ""
    name = item.get("name") or label.split(",")[0]
    kind = (item.get("addresstype") or item.get("type") or "").replace("_", " ")
    return {
        "name": name,
        "label": label,
        "kind": kind,
        "lat": lat,
        "lon": lon,
        "bbox": [west, south, east, north],
    }


def search_places(query: str, limit: int = 6) -> list[dict[str, Any]]:
    """Return up to ``limit`` places matching ``query`` (cities, regions, countries, ...).

    :raises ValueError: if the query is empty or too long.
    :raises RuntimeError: if the geocoding service cannot be reached.
    """
    global _last_request
    query = " ".join((query or "").split())
    if not query:
        raise ValueError("Enter a place name.")
    if len(query) > MAX_QUERY_LEN:
        raise ValueError("The search text is too long.")
    limit = max(1, min(int(limit), MAX_RESULTS))
    key = f"{query.lower()}|{limit}"
    if key in _cache:
        return _cache[key]

    params = urlencode({"q": query, "format": "jsonv2", "limit": limit, "accept-language": "en"})
    request = Request(f"{NOMINATIM_URL}?{params}", headers={"User-Agent": USER_AGENT})
    with _lock:
        wait = MIN_INTERVAL_S - (time.monotonic() - _last_request)
        if wait > 0:
            time.sleep(wait)
        try:
            with urlopen(request, timeout=TIMEOUT_S) as response:
                items = json.loads(response.read().decode("utf-8"))
        except (URLError, TimeoutError, json.JSONDecodeError) as exc:
            raise RuntimeError(f"Place search is not available right now ({exc}).") from exc
        finally:
            _last_request = time.monotonic()

    places = [p for p in (_to_place(i) for i in items if isinstance(i, dict)) if p]
    if len(_cache) > 500:
        _cache.clear()
    _cache[key] = places
    return places


__all__ = ["search_places"]
