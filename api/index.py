"""Vercel serverless entrypoint for the TrendDetective API.

Vercel's Python runtime looks for a ``handler`` class derived from
``BaseHTTPRequestHandler``. We reuse :class:`app.WebAppHandler` so the API
logic lives in one place; ``vercel.json`` rewrites every ``/api/*`` request
to this function, and ``self.path`` still holds the original URL.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import WebAppHandler  # noqa: E402


class handler(WebAppHandler):
    """Request handler picked up by Vercel's Python runtime."""
