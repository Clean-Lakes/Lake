#!/usr/bin/env python3
"""Exercise publication ordering and immutable tags without network writes."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

PUBLISHER = Path(__file__).resolve().parent / "publish_lake_macos.sh"
HEAD = "a" * 40


class PublisherTests(unittest.TestCase):
    def scenario(self, state):
        with tempfile.TemporaryDirectory(prefix="lake publisher ' paths ") as directory:
            root = Path(directory)
            (root / "scripts").mkdir()
            shutil.copyfile(PUBLISHER, root / "scripts/publish_lake_macos.sh")
            (root / "VERSION").write_text("0.3.28\n")
            notes = root / "client/macos/RELEASE_NOTES.md"
            notes.parent.mkdir(parents=True)
            notes.write_text("synthetic release\n")
            artifacts = root / "dist/macos/0.3.28/arm64"
            (artifacts / "Lake.app").mkdir(parents=True)
            for extension in ("zip", "dmg"):
                name = "Lake-0.3.28-macos-arm64." + extension
                (artifacts / name).write_bytes(b"synthetic artifact")
                (artifacts / (name + ".sha256")).write_text(hashlib.sha256(b"synthetic artifact").hexdigest() + "  " + name + "\n")
            tools = root / "tools"
            tools.mkdir()
            def tool(name, source):
                path = tools / name
                path.write_text("#!/usr/bin/env python3\n" + source)
                path.chmod(0o700)
            tool("codesign", "raise SystemExit(0)\n")
            tool("git", '''import os, sys
a=sys.argv[1:]
if a == ['branch', '--show-current']: print('master')
elif a[:1] in (['status'], ['fetch']): pass
elif a == ['rev-parse', 'HEAD']: print('a'*40)
elif a == ['rev-parse', 'origin/master']: print(('b' if os.environ['PUBLISH_TEST_STATE']=='stale-master' else 'a')*40)
else: raise SystemExit(2)
''')
            tool("gh", '''import json, os, sys
a=sys.argv[1:]; state=os.environ['PUBLISH_TEST_STATE']
with open(os.environ['PUBLISH_TEST_LOG'], 'a') as log: log.write(json.dumps(a)+'\\n')
if a == ['auth', 'status']: pass
elif a[:3] == ['api', '-X', 'POST']:
    if state == 'lookup-failure': raise SystemExit(1)
elif a[:1] == ['api'] and '/git/ref/tags/' in a[1]:
    if state in ('missing', 'lookup-failure'):
        print(json.dumps({'message':'Not Found', 'status':'404'}))
        raise SystemExit(1)
    if state.startswith('annotated'): print('tag '+'b'*40)
    elif state == 'noncommit': print('blob '+'a'*40)
    else: print('commit '+('c' if state == 'mismatch' else 'a')*40)
elif a[:1] == ['api'] and '/git/tags/' in a[1]: print('commit '+('c' if state == 'annotated-mismatch' else 'a')*40)
elif a[:2] == ['release', 'view']:
    if state == 'missing': raise SystemExit(1)
elif a[:2] == ['release', 'create']: assert '--verify-tag' in a
elif a[:2] not in (['release', 'upload'], ['release', 'edit']): raise SystemExit(2)
''')
            log = root / "calls.jsonl"
            environment = dict(os.environ, PATH=str(tools) + os.pathsep + os.environ["PATH"], PUBLISH_TEST_STATE=state, PUBLISH_TEST_LOG=str(log))
            result = subprocess.run(["/bin/sh", str(root / "scripts/publish_lake_macos.sh")], env=environment, capture_output=True, text=True, timeout=15)
            calls = [json.loads(line) for line in log.read_text().splitlines()] if log.exists() else []
            self.assertFalse(any(call[:3] == ["api", "-X", "PATCH"] for call in calls), "publisher moved a tag")
            return result.returncode, calls

    def test_missing_tag_created_at_exact_head_before_draft_and_upload(self):
        code, calls = self.scenario("missing")
        self.assertEqual(code, 0)
        create_tag = next(i for i, call in enumerate(calls) if call[:3] == ["api", "-X", "POST"])
        self.assertIn("ref=refs/tags/v0.3.28", calls[create_tag])
        self.assertIn("sha=" + HEAD, calls[create_tag])
        create_release = next(i for i, call in enumerate(calls) if call[:2] == ["release", "create"])
        upload = next(i for i, call in enumerate(calls) if call[:2] == ["release", "upload"])
        self.assertLess(create_tag, create_release)
        self.assertLess(create_release, upload)

    def test_matching_tag_and_draft_resume_without_tag_write(self):
        code, calls = self.scenario("matching")
        self.assertEqual(code, 0)
        self.assertFalse(any(call[:1] == ["api"] and "-X" in call for call in calls))
        self.assertTrue(any(call[:2] == ["release", "edit"] for call in calls))

    def test_matching_annotated_tag_resolves_to_exact_commit(self):
        code, calls = self.scenario("annotated")
        self.assertEqual(code, 0)
        self.assertTrue(any(call[:1] == ["api"] and "/git/tags/" in call[1] for call in calls))

    def assert_no_publication(self, state):
        code, calls = self.scenario(state)
        self.assertNotEqual(code, 0)
        self.assertFalse(any(call[:1] == ["release"] and call[1] in ("create", "upload", "edit") for call in calls))

    def test_different_tag_cannot_be_moved_or_receive_new_assets(self):
        self.assert_no_publication("mismatch")

    def test_different_annotated_tag_cannot_be_moved(self):
        self.assert_no_publication("annotated-mismatch")

    def test_lookup_failure_cannot_fall_through_to_upload(self):
        self.assert_no_publication("lookup-failure")

    def test_stale_master_cannot_publish(self):
        self.assert_no_publication("stale-master")

    def test_noncommit_tag_cannot_publish(self):
        self.assert_no_publication("noncommit")


if __name__ == "__main__":
    unittest.main()
