#!/usr/bin/env python3
"""Record Dev build provenance and reject installation from an older checkout."""
import argparse
import hashlib
import json
import re
import subprocess
from pathlib import Path


def git(repo, *args):
    return subprocess.run(["git", "-C", str(repo), *args], capture_output=True, text=True)


def check(repo, manifest):
    if not manifest.exists():
        return
    data = json.loads(manifest.read_text())
    installed = data.get("gitHead", "")
    if not isinstance(installed, str) or not re.fullmatch(r"[0-9a-f]{40}", installed):
        raise ValueError("Dev 构建来源记录无效，请先核对已安装应用的来源")
    if git(repo, "merge-base", "--is-ancestor", installed, "HEAD").returncode != 0:
        # Squash/cherry-pick integration changes commit identities. An exact
        # preserved build-source tree in HEAD's recent first-parent history
        # proves the same baseline as ancestry: every installed path and mode
        # outside docs/ must survive unchanged. Documentation is not a desktop
        # build input; additional files do not remove the installed baseline.
        # Never infer equivalence for a dirty install or from an unknown commit.
        equivalent = False
        if data.get("dirty") is False and git(repo, "cat-file", "-e", installed + "^{commit}").returncode == 0:
            history = git(repo, "rev-list", "--first-parent", "--max-count=64", "HEAD")
            if history.returncode == 0:
                for candidate in history.stdout.splitlines():
                    diff = git(repo, "diff", "--no-ext-diff", "--quiet", "--no-renames", "--diff-filter=DMRTUXB", installed, candidate, "--", ".", ":(exclude)docs/**")
                    if diff.returncode == 0:
                        equivalent = True
                        break
                    if diff.returncode != 1:
                        break
        if not equivalent:
            raise ValueError("当前工作区缺少已安装 Lake Dev 的提交或可核验的完整源码基线，已阻止旧代码覆盖。请使用包含提交 " + installed[:12] + " 的工作区；已安装版本来源：" + str(data.get("sourceRoot", "未知")))


def write(repo, manifest):
    head = git(repo, "rev-parse", "HEAD")
    if head.returncode != 0:
        raise ValueError("无法确定 Dev 构建的 Git 来源")
    data = {
        "schemaVersion": 1, "gitHead": head.stdout.strip(),
        "gitBranch": git(repo, "branch", "--show-current").stdout.strip(),
        "sourceRoot": str(repo.resolve()), "version": (repo / "VERSION").read_text().strip(),
        "dirty": bool(git(repo, "status", "--porcelain").stdout),
    }
    binary = manifest.parent / "lake"
    if binary.exists():
        data["backendSHA256"] = hashlib.sha256(binary.read_bytes()).hexdigest()
    data["uiSourceSHA256"] = {
        name: hashlib.sha256((repo / "web-agent/web/src" / name).read_bytes()).hexdigest()
        for name in ["AIPanel.tsx", "ThinkingTimeline.tsx", "ReplyDuration.tsx", "conversation-progress-model.ts"]
        if (repo / "web-agent/web/src" / name).exists()
    }
    manifest.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=["check", "write"])
    parser.add_argument("repo", type=Path)
    parser.add_argument("manifest", type=Path)
    args = parser.parse_args()
    try:
        (check if args.mode == "check" else write)(args.repo, args.manifest)
    except (ValueError, OSError) as error:
        parser.exit(1, str(error) + "\n")
