#!/usr/bin/env python3
"""Compatibility entry point for the unified Print Garden slicer worker."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
from garden.slicer.worker import main

if __name__ == "__main__":
    raise SystemExit(main())
