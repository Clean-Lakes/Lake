#!/usr/bin/env python3
"""Keep Lake-owned names neutral; audit dependency/attribution/legacy exceptions."""
from collections import Counter
from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parent.parent
OLD = re.compile(r"zcode", re.I)
AUDIT_FILES = {"scripts/check_backend_naming.py", "scripts/test_check_backend_naming.py"}


def exception(path, line):
    if path == 'web-agent/shared/external-agents.ts' and line.strip() == "export const externalAgentNames:Record<ExternalAgentId,string>={'runtime-acp':'ZCode',codex:'Codex'};":
        return 'external ACP product branding'
    if path.startswith("docs/licenses/"):
        return "original licenses"
    if path in AUDIT_FILES:
        return "audit pattern"
    if path == ".gitignore" and line in {"/zcode-plugin-ops-data/", "/.zcodeignore", "/third_party/zcode/"}:
        return "legacy cache guard"
    if path == "docs/validation/lake-local-progress-inventory.json" and line.strip() == '".zcode/",':
        return "archived cache exclusion"
    if path == "runtime/typescript/upstream.json":
        return "pinned provenance"
    if path == "runtime/typescript/session-archive.ts" and line == "export const legacySessionArchiveName = 'zcode-sessions.sqlite';":
        return "legacy archive input"
    if path == "web-agent/shared/runtime-compat.ts" and line in {
        "export const legacyNativeAgentSource = 'zcode_subagent';",
        "export const legacyNativeControlSource = 'zcode_subagent_control';",
    }:
        return "legacy record input"
    if path == "docs/third-party-notices.md" and line.startswith("| [ZCode CLI 0.16.9]"):
        return "historical attribution"
    if path == "runtime/typescript/build.mjs" and line.strip() == '"Lake embeds ZCode 3.17.2 AgentRuntime and Node adapters in a TypeScript HTTP host. " +':
        return "bundled attribution"
    # Real upstream package/layout identifiers belong only at these bindings.
    if path in {"runtime/typescript/sdk.ts", "runtime/typescript/tsconfig.json", "runtime/typescript/build.mjs", "scripts/prepare_typescript_runtime.py"}:
        remaining = re.sub(r"@zcode\\?/|apps/zcode-cli/", "", line)
        if not OLD.search(remaining):
            return "SDK binding"
    if path.endswith(".md"):
        # Preserve source citations, including historical commit URLs. Do not
        # allow the same name in ordinary prose, code blocks or product labels.
        remaining = re.sub(r"https://github\.com/(?:zai-org/ZCode|Clean-Lakes/Lake)/[^\s)]+", "", line)
        remaining = re.sub(r"\.\./third_party/agent-sdk/apps/zcode-cli/[^\s)]+", "", remaining)
        if not OLD.search(remaining):
            return "source citation"
    return None


def audit(root=ROOT):
    names = subprocess.check_output(["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"], cwd=root).decode().split("\0")
    errors, allowed = [], Counter()
    for name in sorted(set(filter(None, names))):
        path = root / name
        if not path.is_file():
            continue
        if OLD.search(name) and not name.startswith("docs/licenses/"):
            errors.append(f"{name}: obsolete first-party path")
        try:
            content = path.read_text()
        except UnicodeError:
            continue
        for number, line in enumerate(content.splitlines(), 1):
            if OLD.search(line):
                category = exception(name, line)
                if category:
                    allowed[category] += 1
                else:
                    errors.append(f"{name}:{number}: obsolete first-party name")
    return errors, allowed


if __name__ == "__main__":
    errors, allowed = audit()
    print("Allowed boundary lines:", dict(sorted(allowed.items())))
    for error in errors:
        print(error, file=sys.stderr)
    print(f"Backend naming: {len(errors)} violations")
    sys.exit(bool(errors))
