#!/usr/bin/env python3
"""Run precompiled x64 package tests in an existing Parallels Windows VM.

Uses standard guest commands and never changes PowerShell execution policy.
All package data and test files are isolated under LOCALAPPDATA/LakeTest.
"""
import argparse
import base64
import hashlib
import json
import pathlib
import subprocess
import uuid

ROOT = pathlib.Path(__file__).resolve().parents[1]


def literal(value):
    return "'" + str(value).replace("'", "''") + "'"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--vm", default="Windows 11")
    parser.add_argument("--version", default=(ROOT / "VERSION").read_text().strip())
    parser.add_argument("--shared-repo", default=r"\\Mac\Home\Desktop\Lake")
    parser.add_argument("--report", type=pathlib.Path, required=True)
    parser.add_argument("--dev", action="store_true")
    args = parser.parse_args()
    report = {"version": args.version, "development": args.dev, "binaryArchitecture": "amd64", "phase": "preparing", "results": [], "guiTest": "pending"}
    app_name = "Lake Dev" if args.dev else "Lake"
    stem = f"Lake-{'Dev-' if args.dev else ''}{args.version}-windows-x86_64"
    directory = ROOT / "dist/windows" / args.version / "x86_64"
    if args.dev:
        directory = directory / "dev"
    package = directory / (stem + ".zip")
    with package.open("rb") as stream:
        report["packageSHA256"] = hashlib.file_digest(stream, "sha256").hexdigest()

    def save():
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")

    def guest(code):
        prefix = "$ProgressPreference='SilentlyContinue';$OutputEncoding=[Console]::OutputEncoding=[Text.UTF8Encoding]::new();"
        encoded = base64.b64encode((prefix + code).encode("utf-16le")).decode()
        assert len(encoded) < 7500, "Split guest commands to respect the Parallels argument limit"
        result = subprocess.run(["prlctl", "exec", args.vm, "--current-user", "powershell.exe", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], capture_output=True)
        if result.returncode != 0:
            raise RuntimeError("Guest command failed: " + result.stdout.decode("utf-8", errors="replace")[-1000:] + result.stderr.decode("utf-8", errors="replace")[-1000:])
        return result.stdout.decode("utf-8-sig").strip()

    save()
    try:
        folder = "LakeTest\\v" + args.version + " test-" + uuid.uuid4().hex[:8]
        info = json.loads(guest("$r=Join-Path $env:LOCALAPPDATA " + literal(folder) + ";New-Item -ItemType Directory -Force -Path $r|Out-Null;[pscustomobject]@{root=$r;nativeArchitecture=$env:PROCESSOR_ARCHITECTURE;os=(Get-CimInstance Win32_OperatingSystem).Caption}|ConvertTo-Json"))
        report.update(info)
        root = info["root"]
        stage = root + r"\package"
        tests = root + r"\tests"
        logs = root + r"\logs"
        home = root + r"\home"
        source = args.shared_repo + "\\dist\\windows\\" + args.version + "\\x86_64" + ("\\dev" if args.dev else "")
        report.update(phase="extracting", home=home)
        save()
        print("Extracting the package into isolated guest storage", flush=True)
        guest("$ErrorActionPreference='Stop';" + "$r=" + literal(root) + ";$p=" + literal(stage) + ";$t=" + literal(tests) + ";New-Item -ItemType Directory -Force -Path $p,$t," + literal(logs) + "," + literal(home) + "|Out-Null;Copy-Item -LiteralPath " + literal(source + "\\" + stem + ".zip") + " -Destination ($r+'\\package.zip');if(Get-Command tar.exe -ErrorAction SilentlyContinue){& tar.exe -xf ($r+'\\package.zip') -C $p;if($LASTEXITCODE -ne 0){throw 'Archive extraction failed'}}else{Expand-Archive -LiteralPath ($r+'\\package.zip') -DestinationPath $p};Copy-Item -Path " + literal(source + r"\validation\*.test.exe") + " -Destination $t")
        desktop = stage + "\\" + app_name + r"\Lake.exe"
        backend = stage + "\\" + app_name + r"\resources\lake.exe"
        runtime = stage + "\\" + app_name + r"\resources\git"
        report.update(desktop=desktop, phase="testing")
        version = guest("& " + literal(backend) + " --version;if($LASTEXITCODE -ne 0){exit $LASTEXITCODE}")
        assert args.version in version, "Packaged CLI version mismatch"
        report["backendVersion"] = version
        report["webViewExitCode"] = int(guest("$p=Start-Process -FilePath " + literal(desktop) + " -ArgumentList '--check-webview' -Wait -PassThru;$p.ExitCode"))
        assert report["webViewExitCode"] == 0, "WebView2 probe failed"
        save()
        jobs = [
            ("desktop", ".", "90s"),
            ("platform", "^TestSSHFileOption", "90s"),
            ("ai", "^Test(SSHAuthenticationMethodBoundary|StreamCompletion|StreamIdle|Idle|ManualCompaction|CancelIdle|ReloadClears|FirstTurn|OversizedSingle|FailedCompaction|CompactionUses|ToolChildContextFailure|ParentContextFailure)", "180s"),
            ("web", "^(TestWindows|TestConsole|TestRemoteShellCwd|TestCommandWaitTimeout|TestConversationFinishesWhenCompleted|TestInteractiveStartupHidesBootstrapTrigger)", "300s"),
        ]
        for name, pattern, timeout in jobs:
            print("Running Windows " + name + " tests", flush=True)
            log = logs + "\\" + name + ".log"
            code = "$env:LAKE_HOME=" + literal(home) + ";$env:LAKE_DEV_HOME=" + literal(home) + ";$env:LAKE_PORTABLE_ROOT=" + literal(runtime) + ";$env:LAKE_TEST_DESKTOP_EXE=" + literal(desktop) + ";$l=" + literal(log) + ";$s=Get-Date;& " + literal(tests + "\\" + name + ".test.exe") + " " + literal("-test.run=" + pattern) + " '-test.v=true' '-test.count=1' " + literal("-test.timeout=" + timeout) + " *> $l;$c=$LASTEXITCODE;[pscustomobject]@{name=" + literal(name) + ";exitCode=$c;passedCases=@(Select-String -LiteralPath $l -Pattern '^\\s*--- PASS:').Count;failedCases=@((Select-String -LiteralPath $l -Pattern '^\\s*--- FAIL:').Line);seconds=[math]::Round(((Get-Date)-$s).TotalSeconds,2);log=$l}|ConvertTo-Json"
            result = json.loads(guest(code))
            result["failedCases"] = [case for case in result.get("failedCases", []) if case]
            report["results"].append(result)
            save()
            print(json.dumps(result, ensure_ascii=False), flush=True)
        launcher = root + r"\Open-Lake-Test.cmd"
        home_variable = "LAKE_DEV_HOME" if args.dev else "LAKE_HOME"
        guest("@('@echo off','set \"" + home_variable + "=%~dp0home\"','start \"\" \"%~dp0package\\" + app_name + "\\Lake.exe\"','exit /b')|Set-Content -LiteralPath " + literal(launcher) + " -Encoding ASCII")
        report.update(launcher=launcher, phase="complete", passed=all(item["exitCode"] == 0 for item in report["results"]))
        save()
        if not report["passed"]:
            raise SystemExit(1)
    except Exception as error:
        report.update(phase="failed", error=str(error))
        save()
        raise


if __name__ == "__main__":
    main()
