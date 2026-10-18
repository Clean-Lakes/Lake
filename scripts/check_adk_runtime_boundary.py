#!/usr/bin/env python3
"""Run the Go AST boundary audit from any working directory."""
from pathlib import Path
import subprocess
import sys

root = Path(__file__).resolve().parent.parent
sys.exit(subprocess.call(["go", "run", "scripts/check_adk_runtime_boundary.go"], cwd=root))
