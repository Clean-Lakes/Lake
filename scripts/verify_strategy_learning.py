#!/usr/bin/env python3
"""Compatibility alias for old report commands. Runs current memory regressions."""
from verify_memory_compatibility import main

if __name__ == "__main__":
    print("Compatibility alias: use scripts/verify_memory_compatibility.py; old experiments are retired.", flush=True)
    raise SystemExit(main())
