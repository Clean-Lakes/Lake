#!/usr/bin/env python3
"""Check the distributed Windows package without mistaking cross-builds for runtime tests."""
import argparse
import hashlib
import json
import pathlib
import shutil
import struct
import subprocess
import zipfile

ROOT = pathlib.Path(__file__).resolve().parents[1]


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def pe(data):
    assert data[:2] == b"MZ", "Missing DOS executable header"
    offset = struct.unpack_from("<I", data, 0x3C)[0]
    assert data[offset:offset + 4] == b"PE\0\0", "Missing PE executable header"
    return {"machine": struct.unpack_from("<H", data, offset + 4)[0],
            "optional_magic": struct.unpack_from("<H", data, offset + 24)[0],
            "subsystem": struct.unpack_from("<H", data, offset + 24 + 68)[0]}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--version", default=(ROOT / "VERSION").read_text().strip())
    parser.add_argument("--report", type=pathlib.Path, required=True)
    parser.add_argument("--dev", action="store_true")
    parser.add_argument("--zip-only", action="store_true")
    args = parser.parse_args()
    directory = ROOT / "dist/windows" / args.version / "x86_64"
    if args.dev:
        directory = directory / "dev"
    app_root = "Lake Dev" if args.dev else "Lake"
    stem = f"Lake-{'Dev-' if args.dev else ''}{args.version}-windows-x86_64"
    checks = {"version": args.version, "runtime_execution": "not performed by this static validator",
              "artifacts": {}, "executables": {}}
    for name in [stem + ".zip"] + ([] if args.zip_only else [stem + "-setup.exe"]):
        path = directory / name
        checksum = digest(path)
        assert path.with_name(name + ".sha256").read_text().split() == [checksum, name], name + " checksum mismatch"
        checks["artifacts"][name] = {"size": path.stat().st_size, "sha256": checksum}
    metadata = json.loads((directory / "build.json").read_text())
    assert metadata["version"] == args.version and metadata["architecture"] == "amd64"
    assert metadata.get("development", False) == args.dev
    if args.dev:
        assert metadata["dataDirectory"] == ".lake-dev"
    assert metadata["portableGit"] == json.loads((ROOT / "client/windows/runtime-lock.json").read_text())
    with zipfile.ZipFile(directory / (stem + ".zip")) as archive:
        assert archive.testzip() is None, "ZIP CRC failure"
        names = archive.namelist()
        assert len(names) == len(set(names)), "Duplicate archive entries"
        for name in names:
            parts = pathlib.PurePosixPath(name.replace("\\", "/")).parts
            assert parts and parts[0] == app_root and ".." not in parts and not name.startswith("/"), "Unsafe archive path"
            assert ".lake" not in parts and ".lake-dev" not in parts, "User data included"
        assert json.loads(archive.read(app_root + "/resources/build.json")) == metadata
        expected = {"Lake.exe": 2, "resources/lake.exe": 3,
                    "resources/git/usr/bin/bash.exe": 3, "resources/git/usr/bin/ssh.exe": 3}
        for name, subsystem in expected.items():
            payload = archive.read(app_root + "/" + name)
            header = pe(payload)
            assert header == {"machine": 0x8664, "optional_magic": 0x20B, "subsystem": subsystem}, name + " is not the expected x64 executable"
            checksum = hashlib.sha256(payload).hexdigest()
            if name in metadata["executables"]:
                assert metadata["executables"][name] == checksum, name + " provenance mismatch"
            checks["executables"][name] = {**header, "sha256": checksum}
            if name in ["Lake.exe", "resources/lake.exe"]:
                for asset in (ROOT / "web-agent/web/dist/assets").iterdir():
                    assert asset.read_bytes() in payload, name + " does not embed current " + asset.name
        assert hashlib.sha256(archive.read(app_root + "/resources/WebView2Setup.exe")).hexdigest() == metadata["webviewBootstrapper"]["sha256"]
        for name in ["README.md", "resources/licenses/Lake-APACHE.txt",
                     "resources/licenses/Microsoft-WebView2-SDK.txt", "resources/THIRD_PARTY_NOTICES.md"]:
            assert archive.read(app_root + "/" + name), name + " is missing or empty"
        checks["zip_entries"] = len(names)
    if not args.zip_only:
        installer = directory / (stem + "-setup.exe")
        checks["installer_header"] = pe(installer.read_bytes())
        assert checks["installer_header"]["machine"] == 0x14C, "Unexpected NSIS bootstrap architecture"
        seven = shutil.which("7zz") or shutil.which("7z")
        assert seven, "7-Zip is required to verify the installer archive"
        subprocess.run([seven, "t", str(installer)], check=True, capture_output=True)
    checks["checks"] = ["SHA-256 sidecars", "ZIP CRC and safe paths", "x64 PE and GUI/console subsystems",
                        "current embedded frontend assets", "pinned runtime and provenance", "licenses"]
    if not args.zip_only:
        checks["checks"].append("NSIS archive integrity")
    checks["passed"] = True
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(checks, indent=2) + "\n")
    print(json.dumps({"passed": True, "version": args.version, "zip_entries": checks["zip_entries"], "report": str(args.report)}))


if __name__ == "__main__":
    main()
