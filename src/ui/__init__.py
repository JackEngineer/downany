"""Frozen PyQt UI — implementation lives in ``legacy/ui`` (not product mainline)."""
from __future__ import annotations

from pathlib import Path

# Submodules resolve under legacy/ui while preserving ``import src.ui.*``.
__path__ = [str(Path(__file__).resolve().parents[2] / "legacy" / "ui")]
