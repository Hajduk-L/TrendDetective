"""Vercel serverless entrypoint for the TrendDetective API.

Vercel's Python runtime looks for a ``handler`` class derived from
``BaseHTTPRequestHandler``. We reuse :class:`app.WebAppHandler` so the API
logic lives in one place; ``vercel.json`` rewrites every ``/api/*`` request
to this function, and ``self.path`` still holds the original URL.
"""

import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

# The deployed code directory is read-only on Vercel. The data sources write
# downloads and caches to relative paths such as ``data/cache``, so run from
# the writable temp directory instead. Bundled files are read via absolute paths.
os.chdir(tempfile.gettempdir())

import global_data  # noqa: E402

# The Global Explorer caches its gridded datasets under an absolute path inside
# the (read-only) code directory; point those caches at the temp directory too.
_GRID_CACHE = Path(tempfile.gettempdir()) / "data" / "cache"
global_data.CACHE_DIR = _GRID_CACHE / "gistemp"
global_data.GISTEMP_FILE = global_data.CACHE_DIR / global_data.GISTEMP_FILE.name
global_data.GPCP_CACHE = _GRID_CACHE / "gpcp" / global_data.GPCP_CACHE.name

# GPCP is fetched in many slow pieces, which exceeds Vercel's request time
# limit. Use the copy bundled in vercel-data/ (refresh it by running the
# download locally) and only fall back to downloading when it is missing.
_BUNDLED_GPCP = Path(__file__).resolve().parent.parent / "vercel-data" / global_data.GPCP_CACHE.name
if _BUNDLED_GPCP.exists():
    global_data.GPCP_CACHE = _BUNDLED_GPCP

from app import WebAppHandler  # noqa: E402


class handler(WebAppHandler):
    """Request handler picked up by Vercel's Python runtime."""
