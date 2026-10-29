"""Shared private-Home Dev acceptance helpers; no learning/experiment actor.

A message is dispatched exactly once. Its new root turn must reach a terminal
state; a preceding answer can never satisfy the next message's wait.
"""
import json
import os
import subprocess
import time
import urllib.request
import uuid

def require(condition, message):
    if not condition:
        raise AssertionError(message)

def wait_for(check, seconds=40):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        value = check()
        if value:
            return value
        time.sleep(0.1)
    raise TimeoutError('Lake fixture wait expired')

class Lake:

    def __init__(self, binary, home, env, native=None):
        self.home = home
        log = home / ('native.log' if native else 'backend.log')
        self.log = log.open('a')
        os.chmod(log, 0o600)
        runtime = home / 'web-agent/runtime.json'
        previous = runtime.stat().st_mtime_ns if runtime.exists() else 0
        command = [str(native), '--lake-home', str(home)] if native else [str(binary), 'web', '--home', str(home), '--port', '0']
        self.process = subprocess.Popen(command, env=env, stdout=self.log, stderr=self.log)

        def ready():
            require(self.process.poll() is None, 'Lake process exited before ready')
            try:
                if runtime.stat().st_mtime_ns != previous:
                    return json.loads(runtime.read_text())
            except (OSError, json.JSONDecodeError):
                pass
        try:
            self.runtime = wait_for(ready)
        except Exception:
            self.stop()
            raise

    def api(self, path, method='GET', data=None):
        headers = {'Authorization': 'Bearer ' + self.runtime['token']}
        if data is not None:
            headers.update({'Content-Type': 'application/json', 'Idempotency-Key': str(uuid.uuid4())})
        request = urllib.request.Request(self.runtime['origin'] + path, method=method, headers=headers, data=None if data is None else json.dumps(data).encode())
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.load(response)

    def session(self, project, title):
        session = self.api('/api/projects/' + project + '/sessions', 'POST', {'title': title})
        self.api('/api/sessions/' + session['id'] + '/ai/configure', 'POST', {'asset_ref': session['resourceIds'][0], 'runtime': 'local', 'profile': 'core', 'silentCommands': True, 'silentTerminalCreation': True, 'contextBudgetMode': 'manual', 'contextWindow': 64000, 'maxOutput': 1024, 'maxSteps': 20})
        return session['id']

    def snapshot(self, session):
        return self.api('/api/sessions/' + session + '/ai/snapshot')

    def send_and_finish(self, session, text):
        previous = self.snapshot(session).get('rootTurnId', '')
        self.api('/api/sessions/' + session + '/messages', 'POST', {'text': text})
        return self.finish(session, previous_turn=previous)

    def finish(self, session, *, previous_turn=None):

        def done():
            view = self.snapshot(session)
            if previous_turn is not None and (not view.get('rootTurnId') or view['rootTurnId'] == previous_turn):
                return None
            require(view['status'] != 'waiting_approval', 'unexpected approval in readonly fixture')
            return view if view['status'] in ('completed', 'failed', 'cancelled', 'interrupted') else None
        return wait_for(done, 70)

    def stop(self):
        if self.process.poll() is None:
            self.process.terminate()
            self.process.wait(timeout=25)
        self.log.close()
