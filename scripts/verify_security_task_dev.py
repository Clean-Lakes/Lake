#!/usr/bin/env python3
"""Exercise the signed backend's original UI protocol with isolated fake targets."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from dev_acceptance import Lake, require


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--binary', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--enforce', action='store_true', help='also activate only this newly created isolated fixture Home')
    args = parser.parse_args()
    binary = args.binary.resolve(strict=True)
    subprocess.run(['codesign', '--verify', '--strict', str(binary)], check=True)
    state = {'calls': 0, 'lake': None, 'session': None, 'alias': None}

    class Model(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_GET(self):
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(b'{"data":[]}')

        def do_POST(self):
            request = json.loads(self.rfile.read(int(self.headers.get('Content-Length', 0))))
            state['last_tool'] = next((x.get('content', '') for x in reversed(request.get('messages', [])) if x.get('role') == 'tool'), '')
            summary = not request.get('tools')
            if not summary:
                state['calls'] += 1
            n = state['calls'] if not summary else -1
            tool, payload, content = None, {}, ''
            if summary:
                content = 'The user requested two original reads of the isolated marker and independent verification. Keep the canonical goal, steps, attempts and original operation references; no summary grants authority.'
            elif n == 1:
                tool, payload = 'work_begin', {'title': 'Validate isolated marker', 'items': [{'id': 'verify', 'title': 'Read and verify the isolated marker twice'}], 'asset_refs': [state['alias']]}
            elif n in (2, 5):
                with sqlite3.connect(state['db']) as db:
                    row = db.execute('SELECT data FROM native_work_goals WHERE session_id=? ORDER BY rowid DESC LIMIT 1', (state['session'],)).fetchone()
                goal = json.loads(row[0])
                tool, payload = 'work_update', {'item_id': goal['items'][0]['id'], 'status': 'running' if n == 2 else 'completed'}
            elif n in (3, 4):
                tool, payload = 'read', {'asset_ref': state['alias'], 'path': state['file']}
            elif n == 6:
                tool, payload = 'work_finish', {'summary': 'Both original reads and the independent human verification passed.'}
            else:
                content = 'The isolated goal has been verified.'
            delta = {'role': 'assistant', 'content': content}
            if tool:
                delta['tool_calls'] = [{'index': 0, 'id': f'isolated-call-{n}', 'type': 'function', 'function': {'name': tool, 'arguments': json.dumps(payload)}}]
            self.send_response(200)
            self.send_header('Content-Type', 'text/event-stream')
            self.end_headers()
            for chunk in ({'choices': [{'index': 0, 'delta': delta, 'finish_reason': None}]}, {'choices': [{'index': 0, 'delta': {}, 'finish_reason': 'tool_calls' if tool else 'stop'}]}):
                self.wfile.write(('data: ' + json.dumps(chunk) + '\n\n').encode())
            self.wfile.write(b'data: [DONE]\n\n')
            self.wfile.flush()

    model = ThreadingHTTPServer(('127.0.0.1', 0), Model)
    threading.Thread(target=model.serve_forever, daemon=True).start()
    env = {k: v for k, v in os.environ.items() if not k.startswith('LAKE_')}
    try:
        with tempfile.TemporaryDirectory(prefix='lake-security-task-dev.') as directory:
            root = Path(directory)
            os.chmod(root, 0o700)
            home, readable = root / 'home', root / 'readable'
            home.mkdir(mode=0o700)
            readable.mkdir(mode=0o700)
            marker = readable / 'marker.txt'
            marker.write_text('LAKE_ISOLATED_SECURITY_MARKER\n')
            marker.chmod(0o600)
            state['file'], state['db'] = str(marker.resolve()), str(home / 'web-agent/adk/sessions.sqlite')
            lake = Lake(binary, home, env)
            state['lake'] = lake
            try:
                project = lake.api('/api/projects', 'POST', {'name': 'Isolated security acceptance'})['id']
                session = lake.api('/api/projects/' + project + '/sessions', 'POST', {'title': 'Original protocol acceptance'})
                sid, resource = session['id'], session['resourceIds'][0]
                state['session'], state['alias'] = sid, 'a_' + hashlib.sha256(resource.encode()).hexdigest()[:16]
                lake.api('/api/settings/model', 'PUT', {'url': f'http://127.0.0.1:{model.server_port}', 'name': 'isolated-security-fixture', 'protocol': 'openai'})
                lake.api('/api/sessions/' + sid + '/ai/configure', 'POST', {'contextBudgetMode': 'manual', 'contextWindow': 2000000, 'maxSteps': 20})
                lake.api('/api/projects/' + project + '/security/policy', 'PUT', {'actionId': 'isolated-policy', 'expectedRevision': 0, 'policy': {'schemaVersion': 1, 'mode': 'restricted', 'resourceIDs': [resource], 'rules': [{'capability': 'file.read', 'effect': 'ask', 'grantable': True, 'confirmation': 'either', 'limits': {'FileRoots': [str(readable.resolve())]}}, {'capability': 'local.execute', 'effect': 'allow'}]}})
                lake.api('/api/sessions/' + sid + '/messages', 'POST', {'text': 'Read the isolated marker twice, preserve the same goal, and verify the result.'})
                answered, approvals = set(), set()
                deadline = time.monotonic() + 90
                while time.monotonic() < deadline:
                    view = lake.api('/api/sessions/' + sid + '/ai/snapshot')
                    question = view.get('question')
                    if question and question['id'] not in answered:
                        answers = {}
                        for item in question['questions']:
                            options = item['options']
                            labels = [x if isinstance(x, str) else x['label'] for x in options]
                            answer = next((x for x in labels if '本任务范围' in x), labels[0])
                            if item['id'] == 'manual_acceptance':
                                with sqlite3.connect(state['db']) as db:
                                    count = db.execute("SELECT count(*) FROM native_operations WHERE session_id=? AND tool='read' AND status='succeeded'", (sid,)).fetchone()[0]
                                    texts = [x[0] for x in db.execute("SELECT data FROM native_evidences WHERE session_id=? AND status='completed'", (sid,))]
                                require(count == 2 and sum('LAKE_ISOLATED_SECURITY_MARKER' in x for x in texts) == 2, 'human verification preceded the actual original reads')
                            answers[item['id']] = [answer]
                        lake.api('/api/sessions/' + sid + '/ai/questionReply', 'POST', {'id': question['id'], 'answers': answers})
                        answered.add(question['id'])
                    pending = view.get('pendingApprovals') or ([view['pending']] if view.get('pending') else [])
                    for approval in pending:
                        if approval['id'] in approvals:
                            continue
                        preview = approval.get('preview') or {}
                        require('before' in preview and 'after' in preview, 'operation scope was not visible in the existing preview')
                        lake.api('/api/sessions/' + sid + '/ai/decision', 'POST', {'id': approval['id'], 'accept': True, 'confirmation': approval.get('confirmation', '')})
                        approvals.add(approval['id'])
                    if state['calls'] >= 6 and view.get('status') == 'completed':
                        break
                    time.sleep(0.1)
                else:
                    errors = [{'title': x.get('title'), 'status': x.get('status'), 'content': x.get('content', '')[:500]} for x in view.get('cards', []) if x.get('status') in ('failed', 'not_executed')]
                    raise AssertionError('isolated original-protocol goal did not finish: ' + json.dumps({'calls': state['calls'], 'status': view.get('status'), 'questions': len(answered), 'approvals': len(approvals), 'lastTool': str(state.get('last_tool', ''))[:1500], 'errors': errors}, ensure_ascii=False))
                with sqlite3.connect(state['db']) as db:
                    goals = db.execute('SELECT id,status FROM native_work_goals WHERE session_id=?', (sid,)).fetchall()
                    tasks = db.execute('SELECT state FROM security_tasks WHERE session_id=?', (sid,)).fetchall()
                    grants = db.execute('SELECT remaining_uses FROM security_task_grants WHERE session_id=?', (sid,)).fetchall()
                    accepted = db.execute("SELECT source_kind,source_interaction_id FROM work_acceptance_records WHERE session_id=? AND verifier_version='human/1'", (sid,)).fetchall()
                    consumed = db.execute("SELECT count(*) FROM native_approvals WHERE session_id=? AND status='consumed'", (sid,)).fetchone()[0]
                require(len(goals) == 1 and goals[0][1] == 'completed', 'goal association or final acceptance failed')
                require(tasks == [('completed',)], 'original task lifecycle did not close')
                require(grants == [(8,)], 'the confirmed ten-use budget was not shared by both reads')
                require(len(accepted) == 1 and accepted[0][0] == 'question' and accepted[0][1] in answered, 'manual acceptance lost its independent interaction source')
                require(consumed == 1 and len(approvals) == 1 and len(answered) == 3, 'scope authorization or final verification repeated')
                if args.enforce:
                    mode = lake.api('/api/security/mode')
                    require(mode['coverage']['ready'] and mode['precondition'] == 'READY', 'complete fixture was not ready for actual enforcement')
                    active = lake.api('/api/security/mode', 'POST', {'actionId': 'activate-isolated-home', 'expectedRevision': mode['revision'], 'mode': 'enforced', 'confirmedDigest': mode['digest']})
                    require(active['mode'] == 'enforced', 'isolated Home activation failed')
                    cli = subprocess.run([str(binary), 'security', 'mode', '--home', str(home)], capture_output=True, text=True, env=env, timeout=20)
                    require(cli.returncode == 0 and json.loads(cli.stdout)['mode'] == 'enforced', 'signed CLI could not use the original live host')
                    created = lake.api('/api/projects', 'POST', {'name': 'Restricted after activation'})['id']
                    default = lake.api('/api/projects/' + created + '/security/policy')['policy']
                    require(default['Mode'] == 'restricted' and not default['DenyLocal'], 'new project did not use the restricted task-authorization default')
                    require(any(x['Capability'] == 'local.execute' and x['Effect'] == 'ask' and x['Grantable'] for x in default['Rules']), 'new project cannot explicitly request controlled local operations')
                report = {'passed': True, 'binarySHA256': hashlib.sha256(binary.read_bytes()).hexdigest(), 'model': 'loopback synthetic fixture', 'goals': 1, 'originalReadOperations': 2, 'nativeApprovalsConsumed': 1, 'humanQuestions': 3, 'remainingUses': 8, 'taskState': 'completed', 'frontendModified': False}
                report['isolatedHomeEnforced'] = args.enforce
                args.output.write_text(json.dumps(report, indent=2) + '\n')
                args.output.chmod(0o600)
                print('PASS: original question/approval protocol, task budget reuse, actual FD reads, independent human acceptance and goal/task completion')
            finally:
                lake.stop()
    finally:
        model.shutdown()
        model.server_close()


if __name__ == '__main__':
    main()
