#!/usr/bin/env python3
"""Verify security foundations with a signed binary and isolated Homes only."""
import argparse
import hashlib
import json
import os
import signal
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import urllib.error

from dev_acceptance import Lake, require


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--binary', type=Path, required=True)
    parser.add_argument('--native', type=Path)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    binary = args.binary.resolve(strict=True)
    if sys.platform == 'darwin':
        subprocess.run(['codesign', '--verify', '--strict', str(binary)], check=True)
    env = {k: v for k, v in os.environ.items() if not k.startswith('LAKE_')}
    results = []
    with tempfile.TemporaryDirectory(prefix='lake-security-acceptance.') as directory:
        home = Path(directory)
        os.chmod(home, 0o700)
        lake = Lake(binary, home, env, native=args.native)
        try:
            require(lake.api('/api/bootstrap')['modelConfigured'] is False, 'fresh Home loaded a model')
            control = json.loads((home / 'security/control.json').read_text())
            root = (home / 'web-agent/adk').resolve()
            require(control['runtimeRoot'] == str(root), 'Web runtime is not canonical')
            require(control['gate'] == 'open', 'fresh Home gate is not open')
            duplicate = subprocess.run([str(binary), 'ai', '--home', str(home)], input='', text=True,
                                       capture_output=True, env=env, timeout=15)
            require(duplicate.returncode != 0 and 'already has an owner' in duplicate.stderr,
                    'stdio was able to fork Web authority')
            results.append('Web/stdio second owner rejected')
        finally:
            # This PID came from the newly created, isolated Home. Native
            # SIGTERM alone can leave its child backend behind on macOS.
            # Stop the owned fixture backend before closing the test window.
            if args.native:
                try:
                    os.kill(int(lake.runtime['pid']), signal.SIGTERM)
                except ProcessLookupError:
                    pass
            lake.stop()
        protocol = subprocess.run([str(binary), 'ai', '--home', str(home)], input='', text=True,
                                  capture_output=True, env=env, timeout=15)
        require(protocol.returncode == 0, 'stdio could not reuse the released canonical runtime')
        require(not (home / 'web-agent/ai/adk/sessions.sqlite').exists(), 'stdio created a second store')
        unchanged = json.loads((home / 'security/control.json').read_text())
        require(unchanged['recoveryEpoch'] == control['recoveryEpoch'], 'normal restart changed epoch')
        db = sqlite3.connect(root / 'sessions.sqlite')
        row = db.execute('SELECT store_id,recovery_epoch FROM security_schema_meta WHERE id=1').fetchone()
        require(row == (control['storeID'], control['recoveryEpoch']), 'control/store identity differs')
        db.execute('UPDATE security_schema_meta SET minimum_reader_version=999')
        db.commit()
        db.close()
        future = subprocess.run([str(binary), 'ai', '--home', str(home)], input='', text=True,
                                capture_output=True, env=env, timeout=15)
        require(future.returncode != 0, 'future database reader was accepted')
        results.extend(['ordinary restart retained epoch and canonical store', 'future reader rejected'])
    with tempfile.TemporaryDirectory(prefix='lake-security-legacy.') as directory:
        home = Path(directory)
        old = home / 'web-agent/ai/adk'
        old.mkdir(parents=True, mode=0o700)
        db = sqlite3.connect(old / 'sessions.sqlite')
        db.execute('CREATE TABLE native_operations(id TEXT PRIMARY KEY,status TEXT)')
        db.execute("INSERT INTO native_operations VALUES('fixture-unknown','unknown')")
        db.commit()
        db.close()
        attempt = subprocess.run([str(binary), 'ai', '--home', str(home)], input='', text=True,
                                 capture_output=True, env=env, timeout=15)
        require(attempt.returncode != 0, 'legacy uncertainty silently resumed')
        control = json.loads((home / 'security/control.json').read_text())
        inventory = json.loads((home / 'security/legacy-inventory.json').read_text())
        require(control['gate'] == 'closed' and inventory['state'] == 'pending_review', 'migration gate bypass')
        require(len(inventory['stores']) == 1 and inventory['stores'][0]['unresolved'] == 1, 'legacy index incomplete')
        require(Path(inventory['stores'][0]['snapshot']).is_file(), 'legacy snapshot missing')
        results.append('legacy unknown archived; gate closed without replay')
    with tempfile.TemporaryDirectory(prefix='lake-security-old-web.') as directory:
        home = Path(directory)
        os.chmod(home, 0o700)
        lake = Lake(binary, home, env)
        try:
            project = lake.api('/api/projects', 'POST', {'name': 'Synthetic old Web schema'})['id']
            session = lake.api('/api/projects/' + project + '/sessions', 'POST', {'title': 'Saved conversation'})['id']
        finally:
            lake.stop()
        web = home / 'web-agent/lake-web.sqlite'
        db = sqlite3.connect(web)
        tables = db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name GLOB 'natural*'").fetchall()
        for (table,) in tables:
            db.execute('DROP TABLE "' + table + '"')
        db.commit()
        db.close()
        control_path = home / 'security/control.json'
        control = json.loads(control_path.read_text())
        control['gate'] = 'closed'
        control_path.write_text(json.dumps(control))
        ledger = home / 'web-agent/adk/sessions.sqlite'
        paths = [web, ledger, control_path]
        before = {path: hashlib.sha256(path.read_bytes()).hexdigest() for path in paths}
        lake = Lake(binary, home, env)
        try:
            require(lake.api('/api/bootstrap')['recoveryReadOnly'] is True, 'recovery gate not shown')
            snapshot = lake.api('/api/sessions/' + session + '/snapshot')
            require(snapshot['session']['id'] == session and snapshot['naturalMemoryNotices'] == [],
                    'legacy conversation did not load without natural preference tables')
            try:
                lake.api('/api/projects', 'POST', {'name': 'must stay blocked'})
                raise AssertionError('recovery allowed a write')
            except urllib.error.HTTPError as error:
                require(error.code == 409, 'unexpected recovery write response')
        finally:
            lake.stop()
        require(all(hashlib.sha256(path.read_bytes()).hexdigest() == digest for path, digest in before.items()),
                'legacy recovery changed the database or control manifest')
        results.append('legacy Web session loaded without migrations; writes blocked; durable files unchanged')
    args.output.write_text(json.dumps({'checks': results, 'signed': sys.platform == 'darwin',
                                      'isolatedHomes': True, 'native': bool(args.native)}, ensure_ascii=False, indent=2) + '\n')
    print('PASS:', '; '.join(results))


if __name__ == '__main__':
    main()
