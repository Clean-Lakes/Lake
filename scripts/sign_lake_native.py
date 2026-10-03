#!/usr/bin/env python3
"""Sign the native Electron application with Lake's persistent local identity."""
import pathlib
import subprocess
import sys

root = pathlib.Path(sys.argv[1])
identity = sys.argv[2]
entitlements = pathlib.Path(__file__).resolve().parents[1] / "third_party/zcode/packages/desktop/build/entitlements.mac.plist"


def sign(path):
    subprocess.run(["codesign", "--force", "--timestamp=none", "--sign", identity,
                    "--entitlements", str(entitlements), str(path)], check=True)


# Sign each Mach-O before its containing bundles; never sign foreign-platform assets.
paths = sorted(root.rglob("*"), key=lambda path: len(path.parts), reverse=True)
for path in paths:
    if not path.is_file() or path.is_symlink():
        continue
    if "lake-remote-assets" in path.parts:
        continue  # Remote archives/releases are immutable data with native manifest hashes.
    with path.open("rb") as stream:
        magic = stream.read(4)
    if magic in (b"\xfe\xed\xfa\xce", b"\xce\xfa\xed\xfe", b"\xfe\xed\xfa\xcf", b"\xcf\xfa\xed\xfe", b"\xca\xfe\xba\xbe", b"\xbe\xba\xfe\xca"):
        sign(path)
for path in paths:
    if path.is_dir() and not path.is_symlink() and path.suffix in (".app", ".framework", ".bundle"):
        sign(path)
sign(root)
