"""python -m src.sidecar 入口。"""
from __future__ import annotations

import sys

from src.sidecar.server import main

if __name__ == "__main__":
    sys.exit(main())
