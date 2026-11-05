#!/usr/bin/env python3
"""Report the full-function migration gate; pending work must fail cutover."""
from pathlib import Path
import json
import sys

root = Path(__file__).resolve().parent.parent
inventory = json.loads((root / "runtime/zcode/api-inventory.json").read_text())
parity = json.loads((root / "runtime/zcode/parity.json").read_text())
required = {row["name"] for row in inventory["operations"]}
verified = set(parity["verifiedOperations"])
candidate_tested = set(parity["candidateTestedOperations"])
unknown = (verified | candidate_tested) - required
pending = sorted(required - verified)
domains = {name: status for name, status in parity["domains"].items() if status != "verified"}
print(f"Lake UI operations: {len(required)}; candidate evidence: {len(candidate_tested)}; full parity verified: {len(verified)}; pending parity: {len(pending)}")
print(f"Domains awaiting full parity: {len(domains)}; cutover allowed: {parity['cutoverAllowed']}")
if unknown:
    print("Unknown operations in matrix: " + ", ".join(sorted(unknown)), file=sys.stderr)
    sys.exit(1)
if "--report" in sys.argv:
    sys.exit(0)
if pending or domains or not parity["cutoverAllowed"]:
    print("TypeScript cutover BLOCKED: full existing functionality has not passed parity acceptance.", file=sys.stderr)
    sys.exit(1)
print("Full TypeScript parity gate passed")
