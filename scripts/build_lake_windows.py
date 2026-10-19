#!/usr/bin/env python3
"""Cross-build the current workbench as a Windows amd64 client and installer."""
import argparse
import hashlib
import json
import os
import pathlib
import shutil
import struct
import sys
import subprocess
import tempfile
import urllib.request
import zipfile

ROOT = pathlib.Path(__file__).resolve().parents[1]


def run(args, **kwargs):
    subprocess.run([str(a) for a in args], check=True, cwd=ROOT, **kwargs)


def sha(path):
    with open(path, "rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def download(url, target, expected=None):
    if target.exists() and (expected is None or sha(target) == expected):
        return
    request = urllib.request.Request(url, headers={"User-Agent": "Lake-Windows-build"})
    temporary = target.with_suffix(target.suffix + ".part")
    try:
        with urllib.request.urlopen(request, timeout=90) as source, temporary.open("wb") as dest:
            shutil.copyfileobj(source, dest)
        if expected and sha(temporary) != expected:
            raise RuntimeError("Downloaded runtime checksum mismatch")
        temporary.replace(target)
    finally:
        temporary.unlink(missing_ok=True)


def tool(name, alternatives=()):
    value = shutil.which(name)
    if value:
        return value
    for path in alternatives:
        if pathlib.Path(path).is_file():
            return str(path)
    raise RuntimeError("Required build tool missing: " + name)


def amd64_pe(path):
    data = pathlib.Path(path).read_bytes()
    assert data[:2] == b"MZ", "Not a Windows executable"
    offset = struct.unpack_from("<I", data, 0x3C)[0]
    assert data[offset:offset + 4] == b"PE\0\0", "Invalid PE signature"
    assert struct.unpack_from("<H", data, offset + 4)[0] == 0x8664, "Expected Windows amd64"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--reuse-web", action="store_true")
    parser.add_argument("--skip-installer", action="store_true")
    parser.add_argument("--dev", action="store_true", help="Build a labeled Dev client with persistent .lake-dev data")
    args = parser.parse_args()
    version = (ROOT / "VERSION").read_text().strip()
    if not __import__("re").fullmatch(r"\d+\.\d+\.\d+(?:\.\d+)?", version):
        raise RuntimeError("Invalid release version")
    if sys.platform == "darwin":
        environment = os.environ.copy()
        if args.reuse_web:
            environment["LAKE_REUSE_WEB_ASSETS"] = "1"
        # This is the only path that creates the user-facing macOS bin/lake.
        run(["scripts/build_lake.sh"], env=environment)
    else:
        if not args.reuse_web:
            pnpm = tool("pnpm")
            if os.name == "nt":
                run(["cmd.exe", "/d", "/c", pnpm, "--dir", "web-agent", "build:web"])
            else:
                run([pnpm, "--dir", "web-agent", "build:web"])
        source = ROOT / "web-agent/web/dist"
        if not (source / "index.html").is_file():
            raise RuntimeError("Missing workbench assets")
        destination = ROOT / "assets/web/dist"
        shutil.rmtree(destination, ignore_errors=True)
        shutil.copytree(source, destination)
    seven = tool("7zz", [shutil.which("7z") or "", os.path.join(os.environ.get("ProgramFiles", "C:/Program Files"), "7-Zip/7z.exe")])
    nsis = None if args.skip_installer else tool("makensis", [os.path.join(os.environ.get("ProgramFiles(x86)", "C:/Program Files (x86)"), "NSIS/makensis.exe")])
    lock = json.loads((ROOT / "client/windows/runtime-lock.json").read_text())
    cache = pathlib.Path(os.environ.get("LAKE_WINDOWS_BUILD_CACHE", str(pathlib.Path.home() / ".cache/lake/windows-build")))
    cache.mkdir(parents=True, exist_ok=True)
    archive = cache / (lock["sha256"] + ".7z.exe")
    download(lock["url"], archive, lock["sha256"])
    bootstrap = cache / "WebView2Setup.exe"
    bootstrap_url = "https://go.microsoft.com/fwlink/p/?LinkId=2124703"
    download(bootstrap_url, bootstrap)
    output = ROOT / "dist/windows" / version / "x86_64"
    if args.dev:
        output = output / "dev"
    output.mkdir(parents=True, exist_ok=True)
    app_name = "Lake Dev" if args.dev else "Lake"
    name = ("Lake-Dev-" if args.dev else "Lake-") + version + "-windows-x86_64"
    env = os.environ.copy()
    env.update(GOOS="windows", GOARCH="amd64", CGO_ENABLED="0", GOWORK="off")
    with tempfile.TemporaryDirectory(prefix="lake-windows-package-") as temporary:
        stage = pathlib.Path(temporary) / app_name
        resources = stage / "resources"
        resources.mkdir(parents=True)
        git = resources / "git"
        run([seven, "x", "-y", "-o" + str(git), archive], stdout=subprocess.DEVNULL)
        for item in ("usr/bin/sh.exe", "usr/bin/ssh.exe"):
            if not (git / item).is_file():
                raise RuntimeError("PortableGit lacks " + item)
        # Match the runtime window/tray artwork, including native small sizes.
        ico = ROOT / "client/windows/icon.ico"
        icon = ico.read_bytes()
        assert icon[:4] == b"\x00\x00\x01\x00"
        count = struct.unpack_from("<H", icon, 4)[0]
        assert len(icon) >= 6 + count * 16
        sizes = {icon[6 + i * 16] or 256 for i in range(count)}
        assert {16, 20, 24, 32, 40, 48, 64, 128, 256} <= sizes
        generated_resource = ROOT / "client/windows/rsrc_windows_amd64.syso"
        run(["go", "run", "github.com/akavel/rsrc@v0.10.2", "-arch", "amd64", "-manifest", ROOT / "client/windows/app.manifest", "-ico", ico, "-o", generated_resource])
        run(["go", "build", "-trimpath", "-ldflags", "-X main.version=" + version, "-o", resources / "lake.exe", "./cmd/lake"], env=env)
        desktop_flags = "-H windowsgui -X main.version=" + version + (" -X main.development=1" if args.dev else "")
        run(["go", "build", "-trimpath", "-ldflags", desktop_flags, "-o", stage / "Lake.exe", "./client/windows"], env=env)
        for executable in (stage / "Lake.exe", resources / "lake.exe", git / "usr/bin/bash.exe", git / "usr/bin/ssh.exe"):
            amd64_pe(executable)
        shutil.copy2(bootstrap, resources / "WebView2Setup.exe")
        shutil.copy2(ROOT / "client/windows/README.md", stage / "README.md")
        licenses = resources / "licenses"
        licenses.mkdir()
        shutil.copy2(ROOT / "LICENSE-APACHE", licenses / "Lake-APACHE.txt")
        shutil.copy2(ROOT / "web-agent/THIRD_PARTY_NOTICES.md", resources / "THIRD_PARTY_NOTICES.md")
        for path in (ROOT / "web-agent/licenses").iterdir():
            if path.is_file():
                shutil.copy2(path, licenses / path.name)
        module_cache = pathlib.Path(subprocess.check_output(["go", "env", "GOMODCACHE"], cwd=ROOT, text=True).strip())
        for module in ("github.com/UserExistsError/conpty", "github.com/jchv/go-webview2", "github.com/jchv/go-winloader", "modernc.org/sqlite", "modernc.org/libc", "modernc.org/memory", "modernc.org/mathutil", "golang.org/x/sys"):
            metadata = json.loads(subprocess.check_output(["go", "list", "-m", "-json", module], cwd=ROOT, text=True))
            escaped = "".join("!" + c.lower() if c.isupper() else c for c in module)
            directory = module_cache / (escaped + "@" + metadata["Version"])
            for filename in ("LICENSE", "LICENSE.txt"):
                if (directory / filename).is_file():
                    shutil.copy2(directory / filename, licenses / (module.replace("/", "_") + ".txt"))
                    break
        loader_license = next((module_cache / "github.com/jchv").glob("go-webview2@*/webviewloader/sdk/LICENSE.txt"))
        shutil.copy2(loader_license, licenses / "Microsoft-WebView2-SDK.txt")
        provenance = {"version": version, "architecture": "amd64", "development": args.dev,
                      "dataDirectory": ".lake-dev" if args.dev else ".lake", "portableGit": lock,
                      "webviewBootstrapper": {"url": bootstrap_url, "sha256": sha(bootstrap)},
                      "executables": {str(p.relative_to(stage)): sha(p) for p in (stage / "Lake.exe", resources / "lake.exe")}}
        (resources / "build.json").write_text(json.dumps(provenance, indent=2) + "\n")
        package = output / (name + ".zip")
        with zipfile.ZipFile(package, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as archive_out:
            for path in sorted(stage.rglob("*")):
                if path.is_file():
                    archive_out.write(path, str(path.relative_to(stage.parent)))
        assets = [package]
        if nsis:
            installer = output / (name + "-setup.exe")
            # VIProductVersion requires exactly four numeric fields.
            product_version = version + ".0" if version.count(".") == 2 else version
            # Build the glob with the host's native separator. Appending a POSIX
            # slash to a Windows path makes NSIS fail to find the payload.
            run([nsis, "-V2", "-INPUTCHARSET", "UTF8", *(["-DDEV_BUILD=1"] if args.dev else []), "-DAPP_NAME=" + app_name, "-DUNINSTALL_KEY=" + ("CleanLakesDev" if args.dev else "CleanLakes"), "-DVERSION=" + version, "-DPRODUCT_VERSION=" + product_version, "-DAPP_FILES=" + str(stage / "*"), "-DOUTPUT=" + str(installer), ROOT / "client/windows/installer.nsi"])
            assets.append(installer)
        for path in assets:
            path.with_name(path.name + ".sha256").write_text(sha(path) + "  " + path.name + "\n")
            print(str(path))
        (output / "build.json").write_text(json.dumps(provenance, indent=2) + "\n")


if __name__ == "__main__":
    main()
