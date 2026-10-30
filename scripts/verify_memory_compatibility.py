#!/usr/bin/env python3
"""Run credential-free memory and legacy-compatibility regressions on the current OS; emit actual results.

This is reliability evidence, not a model-benefit or desktop acceptance report.
Does not build/install Lake, invoke a remote provider, or dispatch GitHub Actions.
"""
import argparse
import datetime
import json
import os
import pathlib
import platform
import subprocess
import time

ROOT = pathlib.Path(__file__).resolve().parents[1]
TEST_PATTERN = "^(TestC[34]|TestLegacy|TestNatural|TestMemory|TestProjectMemory|TestStrategy|TestOnline|TestHistorical|TestADK.*(Approval|Unknown|Crash|Projection)|TestCancelIdle|TestManualCompaction|TestSegmentedCompaction|TestInspectHost|TestConfiguredSkills|TestSkillPath|TestExtensionSettings|TestModelSwitch|TestCompaction|TestAutomaticCompaction|TestIdle|TestUnknownMutation|TestUnfinishedMutation|TestSREPlanOnly|TestSRERestart)"

SUITES = [
    ["go", "test", "-json", "./internal/strategy", "./internal/testsupport/legacystrategy", "-count=1", "-timeout=3m"],
    ["go", "test", "-json", "./internal/ai", "./internal/web", "-run",
     TEST_PATTERN, "-count=1", "-timeout=5m"],
]


def git(*args):
    return subprocess.check_output(["git", *args], cwd=ROOT, text=True).strip()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report", required=True, type=pathlib.Path)
    parser.add_argument("--packages", nargs="+", choices=["internal/strategy", "internal/ai", "internal/web"], default=["internal/strategy", "internal/ai", "internal/web"])
    args = parser.parse_args()
    suites=[]
    if "internal/strategy" in args.packages:
        suites.append(SUITES[0])
    runtime=["./"+p for p in args.packages if p!="internal/strategy"]
    if runtime:
        suites.append(["go","test","-json",*runtime,"-run",TEST_PATTERN,"-count=1","-timeout=5m"])
    args.report.parent.mkdir(parents=True, exist_ok=True)
    report = {
        "schemaVersion": 1, "kind": "memory_compatibility_regression", "status": "running",
        "startedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "commit": git("rev-parse", "HEAD"), "dirty": bool(git("status", "--porcelain")),
        "platform": {"os": platform.system(), "architecture": platform.machine()},
        "go": None, "packagesRequested": args.packages,
        "modelBenefitEvaluated": False, "desktopEvaluated": False, "suites": [],
    }

    def save():
        args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
        os.chmod(args.report, 0o600)

    save()
    failed = False
    try:
        report["go"] = subprocess.check_output(["go", "version"], text=True,
                                               stderr=subprocess.DEVNULL).strip()
        for command in suites:
            start = time.monotonic()
            # Output can contain test diagnostics. Keep it in a private local
            # file; publish only identities/statuses, never request bodies.
            log = args.report.with_name(args.report.stem + f"-{len(report['suites'])}.log")
            tests, packages = {}, {}
            with log.open("w", encoding="utf-8") as stream:
                os.chmod(log, 0o600)
                result = subprocess.run(command, cwd=ROOT, stdout=stream,
                                        stderr=subprocess.STDOUT, timeout=660)
            for line in log.read_text(encoding="utf-8").splitlines():
                try:
                    event = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if event.get("Action") not in ("pass", "fail", "skip"):
                    continue
                package, name = event.get("Package", ""), event.get("Test", "")
                if name:
                    tests[(package, name)] = {"package": package, "test": name,
                                             "status": event["Action"]}
                else:
                    packages[package] = event["Action"]
            top = [t for t in tests.values() if "/" not in t["test"]]
            # A successful process with no selected tests is not acceptance.
            qualifying = [t for t in top if not t["test"].endswith("Helper")]
            requested = {p.removeprefix("./") for p in command if p.startswith("./internal/")}
            ok = result.returncode == 0 and all(
                any(t["status"] == "pass" and t["package"].endswith("/" + p) for t in qualifying)
                and any(pkg.endswith("/" + p) and status == "pass" for pkg, status in packages.items())
                for p in requested
            )
            ok = ok and not any(t["status"] == "fail" for t in tests.values())
            report["suites"].append({"command": command, "exitCode": result.returncode,
                                     "seconds": round(time.monotonic() - start, 3),
                                     "passed": ok, "packages": packages,
                                     "tests": sorted(tests.values(), key=lambda t: (t["package"], t["test"]))})
            save()
            failed |= not ok
            print(f"{len(top)} top-level tests; {'passed' if ok else 'FAILED'}", flush=True)
    except (Exception, KeyboardInterrupt) as error:
        # Avoid persisting subprocess output or environment contents.
        report["error"] = type(error).__name__
        failed = True
    finally:
        report["status"] = "failed" if failed else "passed"
        report["finishedAt"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        save()
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
