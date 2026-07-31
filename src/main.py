"""Redirect to frozen PyQt entry. Prefer: npm run desktop."""
from __future__ import annotations

import runpy
from pathlib import Path

if __name__ == "__main__":
    runpy.run_path(str(Path(__file__).resolve().parents[1] / "legacy" / "main.py"), run_name="__main__")
