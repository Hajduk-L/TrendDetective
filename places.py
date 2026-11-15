"""Look up cities and regions by name or coordinates (``GET /api/places?q=...``).

Uses the OpenStreetMap Nominatim search service. Its usage policy asks for at most
one request per second and an identifying User-Agent, so requests are serialised,
spaced out and cached in memory.
"""
from __future__ import annotations

import json
import re
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
_cache_lock = threading.Lock()  # guards _cache; _lock serialises requests to Nominatim
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


# One coordinate: decimal degrees or degrees/minutes/seconds, with an optional
# sign or hemisphere letter, e.g. "50.77", "-6.08", "50°46'31\"N", "6 05 E".
_COORD = re.compile(
    r"""\s*(?P<pre>[NSEWnsew])?\s*
        (?P<deg>[+-]?\d+(?:[.,]\d+)?)\s*(?:°|º|deg|d)?\s*
        (?:(?P<min>\d+(?:[.,]\d+)?)\s*(?:'|′|’|m)?\s*)?
        (?:(?P<sec>\d+(?:[.,]\d+)?)\s*(?:"|″|”|''|s)?\s*)?
        (?P<post>[NSEWnsew])?\s*$""",
    re.VERBOSE,
)
_SEPARATOR = re.compile(r"\s*[,;/]\s*|\s+(?=[+-]?\d)|(?<=[NSEWnsew])\s*(?=[NSEWnsew+-]?\s*\d)")


def _parse_coordinate(text: str) -> tuple[float, str | None] | None:
    """Parse one coordinate into (degrees, hemisphere letter or None)."""
    match = _COORD.match(text)
    if not match or (match["pre"] and match["post"]):
        return None
    value = abs(float(match["deg"].replace(",", ".")))
    if match["min"]:
        value += float(match["min"].replace(",", ".")) / 60
    if match["sec"]:
        value += float(match["sec"].replace(",", ".")) / 3600
    if (match["min"] or match["sec"]) and "." in match["deg"].replace(",", "."):
        return None
    if any(match[k] and float(match[k].replace(",", ".")) >= 60 for k in ("min", "sec")):
        return None
    hemisphere = (match["pre"] or match["post"] or "").upper() or None
    negative = match["deg"].startswith("-") or hemisphere in ("S", "W")
    return (-value if negative else value), hemisphere


def parse_coordinates(query: str) -> tuple[float, float] | None:
    """Read ``query`` as a latitude/longitude pair, or return None.

    Accepts "50.77, 6.08", "50.77 6.08", "50.77N 6.08E", "6.08E 50.77N" and
    degrees/minutes/seconds such as "50°46'31\"N 6°5'2\"E". Without hemisphere
    letters the order is latitude, longitude (swapped if the first value only
    fits as a longitude).
    """
    text = query.strip()
    if not re.search(r"\d", text):
        return None
    # "50,77 6,08" or "50,77; 6,08": decimal commas.
    if re.fullmatch(r"[+-]?\d+,\d+\s*[\s;/]\s*[+-]?\d+,\d+", text):
        text = text.replace(",", ".")
    candidates = []
    for split in _SEPARATOR.finditer(text):
        left, right = text[: split.start()], text[split.end():]
        a, b = _parse_coordinate(left), _parse_coordinate(right)
        if a and b:
            candidates.append((a, b))
    for (v1, h1), (v2, h2) in candidates:
        if h1 in ("E", "W") or h2 in ("N", "S"):
            (v1, h1), (v2, h2) = (v2, h2), (v1, h1)
        if h1 in ("E", "W") or h2 in ("N", "S"):
            continue
        lat, lon = v1, v2
        if abs(lat) > 90 and abs(lon) <= 90 and h1 is None and h2 is None:
            lat, lon = lon, lat
        if abs(lat) <= 90 and abs(lon) <= 180:
            return lat, lon
    return None


def _coordinate_place(lat: float, lon: float) -> dict[str, Any]:
    ns, ew = ("N" if lat >= 0 else "S"), ("E" if lon >= 0 else "W")
    name = f"{abs(lat):.4f}°{ns}, {abs(lon):.4f}°{ew}"
    return {
        "name": name,
        "label": f"Latitude {lat:.5f}, longitude {lon:.5f}",
        "kind": "coordinates",
        "lat": lat,
        "lon": lon,
        "bbox": [lon - 0.05, lat - 0.035, lon + 0.05, lat + 0.035],
    }


def search_places(query: str, limit: int = 6) -> list[dict[str, Any]]:
    """Return up to ``limit`` places matching ``query`` (cities, regions, countries, ...).

    A query that reads as coordinates ("50.77, 6.08") returns that point directly.

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
    coords = parse_coordinates(query)
    if coords:
        return [_coordinate_place(*coords)]
    key = f"{query.lower()}|{limit}"
    with _cache_lock:
        cached = _cache.get(key)
    if cached is not None:
        return cached

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
    with _cache_lock:
        if len(_cache) > 500:
            _cache.clear()
        _cache[key] = places
    return places


__all__ = ["parse_coordinates", "search_places"]
