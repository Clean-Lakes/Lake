#!/usr/bin/env python3
"""Upload local signed packages via SSH Git and a temporary, auto-cleaned asset tag."""
import json
import os
import pathlib
import re
import subprocess
import tempfile

root = pathlib.Path(__file__).resolve().parents[1]
os.chdir(root)
version = (root / "VERSION").read_text().strip()
if not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", version):
    raise SystemExit("Invalid release version")
commit = subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip()
if subprocess.check_output(["git", "branch", "--show-current"], text=True).strip() != "master":
    raise SystemExit("Publish from master")
if subprocess.check_output(["git", "status", "--porcelain", "--untracked-files=no"], text=True).strip():
    raise SystemExit("Commit release changes first")
subprocess.run(["git", "fetch", "origin", "refs/heads/master:refs/remotes/origin/master"], check=True)
if commit != subprocess.check_output(["git", "rev-parse", "origin/master"], text=True).strip():
    raise SystemExit("Push master first")
assets = root / "dist/macos" / version / "arm64"
name = f"Lake-{version}-macos-arm64"
for extension in ["zip", "dmg"]:
    subprocess.run(["shasum", "-a", "256", "-c", f"{name}.{extension}.sha256"], cwd=assets, check=True)
subprocess.run(["codesign", "--verify", "--deep", "--strict", str(assets / "Lake.app")], check=True)
with tempfile.TemporaryDirectory(prefix="lake-release-index-") as directory:
    env = os.environ.copy()
    env["GIT_INDEX_FILE"] = str(pathlib.Path(directory) / "index")

    def git(*arguments, data=None):
        return subprocess.check_output(["git", *arguments], input=data, env=env).decode().strip()

    git("read-tree", commit)
    for extension in [".zip", ".zip.sha256", ".dmg", ".dmg.sha256"]:
        file = name + extension
        blob = git("hash-object", "-w", str(assets / file))
        git("update-index", "--add", "--cacheinfo", f"100644,{blob},release-assets/macos/{file}")
    metadata = json.dumps({"version": version, "commit": commit}).encode()
    blob = git("hash-object", "-w", "--stdin", data=metadata)
    git("update-index", "--add", "--cacheinfo", f"100644,{blob},release-assets/macos/release.json")
    prepared = git("commit-tree", git("write-tree"), "-p", commit, data=f"Prepare signed Lake {version} assets\n".encode())
tag = "lake-macos-assets-v" + version
subprocess.run(["git", "tag", tag, prepared], check=True)
subprocess.run(["git", "push", "origin", "refs/tags/" + tag], check=True)
print("Signed packages staged; the publishing workflow removes the temporary tag after success.")
