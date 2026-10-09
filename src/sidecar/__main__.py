"""python -m src.sidecar 入口。"""
from __future__ import annotations

import multiprocessing
import sys

from src.sidecar.entrypoint import main

if __name__ == "__main__":
    multiprocessing.freeze_support()
    sys.exit(main())
