"""Sphinx configuration for the TrendDetective API reference."""

from __future__ import annotations

import os
import sys
from datetime import date
from pathlib import Path

PROJECT_ROOT: Path = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT))

project: str = "TrendDetective"
author: str = "TrendDetective contributors"
copyright: str = f"{date.today().year}, {author}"
extensions: list[str] = ["sphinx.ext.autodoc", "sphinx.ext.napoleon", "sphinx.ext.viewcode"]
autodoc_typehints: str = "description"
autodoc_member_order: str = "bysource"
napoleon_use_param: bool = True
napoleon_use_rtype: bool = True
templates_path: list[str] = ["_templates"]
exclude_patterns: list[str] = ["_build"]
html_theme: str = "alabaster"

# Read the package version from an environment override when building releases.
release: str = os.getenv("TRENDETECTIVE_VERSION", "0.1.0")
