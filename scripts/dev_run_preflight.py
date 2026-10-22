#!/usr/bin/env python3
"""Check fixed Dev paths and reject a live backend before rebuilding."""
import json
import os
from pathlib import Path


def check_dev_home(dev_home, release_home):
    for path in (dev_home, dev_home / "web-agent"):
        if path.is_symlink() or path.resolve().is_relative_to(release_home.resolve()):
            raise ValueError("Dev 路径不得链接到正式数据或使用符号链接")
    runtime = dev_home / "web-agent/runtime.json"
    if not runtime.exists():
        return
    # Never print the runtime payload: it also contains the local API token.
    data = json.loads(runtime.read_text())
    pid = data.get("pid")
    if type(pid) is not int or pid <= 0:
        raise ValueError("Dev 后端记录无效，请先核对现有运行状态")
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return
    except PermissionError:
        pass
    raise ValueError("Dev 后端仍在运行；请正常退出 Lake Dev，并在原启动终端 Ctrl+C 后重试")


if __name__ == "__main__":
    try:
        check_dev_home(Path.home() / ".lake-dev", Path.home() / ".lake")
    except (ValueError, OSError) as error:
        raise SystemExit(str(error))
