#!/usr/bin/env python3
"""Install the optional pinned local recall index for Lake Dev, without IDE hooks."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import socket
import subprocess
import shutil


def private_path(path, release_home):
    if path.is_symlink() or path.resolve().is_relative_to(release_home.resolve()):
        raise ValueError("Claude-Mem Dev 路径不得链接到正式数据")
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    if path.stat().st_uid != os.getuid():
        raise ValueError("Claude-Mem Dev 目录不属于当前用户")
    path.chmod(0o700)


def install(dev_home, repo):
    release_home = Path.home() / ".lake"
    private_path(dev_home, release_home)
    root = dev_home / "claude-mem"
    private_path(root, release_home)
    engine = root / "engine"
    private_path(engine, release_home)
    spec = json.loads((repo / "runtime/claude-mem/upstream.json").read_text())
    node = repo / "third_party/.lake-cache/node-v24.14.0-darwin-arm64/bin"
    environment = {**os.environ, "PATH": str(node) + os.pathsep + os.environ.get("PATH", "")}
    subprocess.run([str(node / "npm"), "install", "--ignore-scripts", "--omit=dev", "--prefix", str(engine),
                    "claude-mem@" + spec["version"], "bun@" + spec["bunVersion"]], env=environment, check=True)
    lock = json.loads((engine / "package-lock.json").read_text())
    package = lock["packages"]["node_modules/claude-mem"]
    if package["version"] != spec["version"] or package["integrity"] != spec["integrity"]:
        raise ValueError("Claude-Mem 包版本或完整性与固定版本不符")
    bun = engine / "node_modules/@oven/bun-darwin-aarch64/bin/bun"
    worker = engine / "node_modules/claude-mem/plugin/scripts/worker-service.cjs"
    guard = root / "guard.cjs"
    if guard.is_symlink():
        raise ValueError("Claude-Mem 保护入口不能使用符号链接")
    shutil.copyfile(repo / "runtime/claude-mem/guard.cjs", guard)
    guard.chmod(0o600)
    config_file = root / "index.json"
    if config_file.is_symlink():
        raise ValueError("Claude-Mem 配置不能使用符号链接")
    previous = json.loads(config_file.read_text()) if config_file.exists() else {}
    port = previous.get("port")
    if type(port) is not int or not 1024 <= port <= 65535:
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            port = listener.getsockname()[1]
    config = {"version": 1, "enabled": True, "managed": True, "port": port,
              "bunSHA256": hashlib.sha256(bun.read_bytes()).hexdigest(),
              "workerSHA256": hashlib.sha256(worker.read_bytes()).hexdigest(),
              "guardSHA256": hashlib.sha256(guard.read_bytes()).hexdigest()}
    descriptor = os.open(config_file, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(descriptor, "w") as stream:
        json.dump(config, stream)
    config_file.chmod(0o600)
    print("Claude-Mem 本地检索已配置；下次启动 Lake Dev 时由内核启动并管理。")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dev", action="store_true", required=True)
    parser.parse_args()
    if platform.system() != "Darwin" or platform.machine() != "arm64":
        raise SystemExit("当前试接仅验证 macOS arm64 Lake Dev")
    install(Path.home() / ".lake-dev", Path(__file__).resolve().parent.parent)
