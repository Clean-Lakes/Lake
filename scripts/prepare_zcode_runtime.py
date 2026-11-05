#!/usr/bin/env python3
"""Prepare the pinned upstream source and verified Node build tool, without secrets."""
from pathlib import Path
import hashlib
import json
import os
import platform
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.request

ROOT = Path(__file__).resolve().parent.parent
LOCK = json.loads((ROOT / "runtime/zcode/upstream.json").read_text())
CACHE = ROOT / "third_party/.lake-cache"
SOURCE = ROOT / "third_party/zcode"
NODE_SHA256 = {
    ("Darwin", "arm64"): "a1a54f46a750d2523d628d924aab61758a51c9dad3e0238beb14141be9615dd3",
    ("Darwin", "x86_64"): "f2879eb810e25993a0578e5d878930266fd2eafcffe9f2839b3d8db354d4879e",
    ("Linux", "x86_64"): "dbf5b8665dec15e59e6359a517fefb47b23fdb9152d8def975b9bca3dfc6d355",
    ("Linux", "aarch64"): "f44740cd218de8127f1c44c41510a3a740fa5c9c8d1cdce1c3bedada79f3cde7",
}


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def download(url, target, expected):
    if target.exists() and digest(target) == expected:
        return
    partial = target.with_suffix(target.suffix + ".part")
    with urllib.request.urlopen(url, timeout=120) as response, partial.open("wb") as output:
        shutil.copyfileobj(response, output)
    if digest(partial) != expected:
        raise RuntimeError("Downloaded archive SHA-256 does not match the pinned manifest")
    partial.replace(target)


def prepare_source():
    archive = CACHE / "zcode-v3.17.2.tar.gz"
    download(LOCK["archive"], archive, LOCK["sha256"])
    with tarfile.open(archive) as tar:
        if not SOURCE.exists():
            with tempfile.TemporaryDirectory(prefix="zcode-source-", dir=CACHE) as staging:
                tar.extractall(staging, filter="data")
                (Path(staging) / "ZCode-3.17.2").replace(SOURCE)
        # Verify original source bytes even when generated dist/node_modules exist.
        # Local upstream changes require an explicit patch/provenance workflow.
        for member in tar:
            if not member.isfile():
                continue
            relative = Path(*Path(member.name).parts[1:])
            candidate = SOURCE / relative
            original = tar.extractfile(member)
            if not candidate.is_file() or hashlib.sha256(original.read()).hexdigest() != digest(candidate):
                raise RuntimeError(f"Pinned upstream source differs: {relative}")


def prepare_node():
    key = (platform.system(), platform.machine())
    if key not in NODE_SHA256:
        raise RuntimeError(f"Verified Node toolchain is not configured for {key}")
    system = {"Darwin": "darwin", "Linux": "linux"}[key[0]]
    arch = "arm64" if key[1] in ("arm64", "aarch64") else "x64"
    name = f"node-v{LOCK['node']}-{system}-{arch}"
    archive = CACHE / (name + ".tar.gz")
    download(f"https://nodejs.org/dist/v{LOCK['node']}/{name}.tar.gz", archive, NODE_SHA256[key])
    directory = CACHE / name
    if not directory.exists():
        with tarfile.open(archive) as tar:
            tar.extractall(CACHE, filter="data")
    node = directory / "bin/node"
    if subprocess.check_output([node, "--version"], text=True).strip() != "v" + LOCK["node"]:
        raise RuntimeError("Unexpected Node build-tool version")
    return node


def main():
    CACHE.mkdir(parents=True, exist_ok=True)
    node = prepare_node()
    prepare_source()
    env = dict(os.environ, PATH=str(node.parent) + os.pathsep + os.environ.get("PATH", ""), HUSKY="0")
    subprocess.run(["pnpm", "--filter", "@zcode/bootstrap...", "install", "--frozen-lockfile", "--ignore-scripts"], cwd=SOURCE, env=env, check=True, stdout=sys.stderr)
    subprocess.run(["pnpm", "--filter", "@zcode/bootstrap...", "build"], cwd=SOURCE, env=env, check=True, stdout=sys.stderr)
    print(node)


if __name__ == "__main__":
    main()
