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

from app import WebAppHandler  # noqa: E402


class handler(WebAppHandler):
    """Request handler picked up by Vercel's Python runtime."""
