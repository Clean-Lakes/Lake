#!/usr/bin/env python3
"""Verify inherited project MCP through a signed Dev backend in a disposable Home."""
import argparse
from contextlib import contextmanager
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
import sys
from pathlib import Path
import sqlite3
import subprocess
import tempfile
import threading
import time

from dev_acceptance import Lake, require


@contextmanager
def serve(handler):
    with ThreadingHTTPServer(('127.0.0.1', 0), handler) as service:
        thread = threading.Thread(target=service.serve_forever, daemon=True)
        thread.start()
        try:
            yield f'http://127.0.0.1:{service.server_port}'
        finally:
            service.shutdown()
            thread.join()


class QuietHTTP(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def request_json(self):
        return json.loads(self.rfile.read(int(self.headers['Content-Length'])))

    def json_reply(self, status, data):
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(json.dumps(data).encode())


def exercise(binary, home, native):
    # Only the loopback MCP returns the receipt. Check it in the actual tool
    # result and durable operation before independently accepting the task.
    marker = os.urandom(16).hex()
    requests = []
    tool_name = 'read_release_count'
    count_title = 'Count releases using the release fixture MCP'
    catalog_title = 'List the MCP servers visible to this project'
    database = home / 'web-agent/adk/sessions.sqlite'

    def rows(sql, args=()):
        with sqlite3.connect(f'file:{database}?mode=ro', uri=True) as db:
            return db.execute(sql, args).fetchall()

    class MCP(QuietHTTP):
        def do_POST(self):
            rpc = self.request_json()
            method = rpc.get('method')
            if method == 'notifications/initialized':
                self.send_response(202)
                self.end_headers()
                return
            if method == 'initialize':
                result = {'protocolVersion': rpc['params']['protocolVersion'], 'capabilities': {'tools': {}}, 'serverInfo': {'name': 'release-fixture', 'version': '1'}}
            elif method == 'tools/list':
                result = {'tools': [{'name': tool_name, 'description': 'Count fixture releases', 'inputSchema': {'type': 'object', 'properties': {}, 'additionalProperties': False}}]}
            elif method == 'tools/call' and rpc['params']['name'] == tool_name and not rpc['params'].get('arguments'):
                requests.append(tool_name)
                result = {'content': [{'type': 'text', 'text': f'17 releases; receipt {marker}'}]}
            else:
                self.json_reply(200, {'jsonrpc': '2.0', 'id': rpc.get('id'), 'error': {'code': -32601, 'message': 'unexpected fixture method'}})
                return
            self.json_reply(200, {'jsonrpc': '2.0', 'id': rpc['id'], 'result': result})

    steps = {}
    projects = {}
    errors = []
    server_id = None
    retries = {}

    def model_turn(request):
        names = {t['function']['name'] for t in request.get('tools', [])}
        results = [str(m.get('content', '')) for m in request['messages'] if m.get('role') == 'tool']
        last = results[-1] if results else ''
        if not names:
            return 'Preserve the original task and its evidence.', None, {}
        role = 'router' if 'route_work' in names else 'worker'
        messages = '\n'.join(str(message.get('content', '')) for message in request['messages'])
        title, = [label for label in projects if label in messages]
        count = title == count_title
        key = (role, title, title in retries)
        steps[key] = n = steps.get(key, 0) + 1
        if role == 'router':
            if n == 1:
                event = rows("SELECT id FROM superagent_events WHERE project_id=? AND source_kind='user' AND disposition='pending'", (projects[title],))[0][0]
                route = {'event_id': event, 'part_key': 'inspect', 'action': 'create', 'title': title, 'role_key': 'release specialist', 'quote': title, 'reason': title}
                if title in retries:
                    route.update(action='followup', task_id=retries[title]['taskId'])
                return '', 'route_work', route
            return 'Assigned to the release specialist.', None, {}
        if count and title not in retries:
            # Reproduce the original failure through the real ADK task repair
            # path. No task records or runtime counters are edited by the fixture.
            return 'The release query needs a plan before it can run.', None, {}
        if n == 1:
            require((server_id in messages) == count, 'Worker planning index lost project scope')
            return '', 'work_begin', {'title': title, 'items': [{'id': 'verify', 'title': title}], 'asset_refs': []}
        completion = 6 if count else 4
        if n == 2 or n == completion:
            goal = json.loads(rows("SELECT data FROM native_work_goals WHERE json_extract(data,'$.title')=?", (title,))[0][0])
            require(not goal.get('resourceBindings'), 'MCP-only task inherited an unrelated asset')
            if n == completion:
                if count:
                    require(marker in last, 'the actual MCP result did not reach the Worker: ' + last[:400])
                else:
                    require(json.loads(last).get('servers') == [], 'the opted-out project saw a global server: ' + last[:400])
            return '', 'work_update', {'item_id': goal['items'][0]['id'], 'status': 'running' if n == 2 else 'completed'}
        if n == 3:
            return '', 'list_mcp_servers', {}
        if count and n == 4:
            server, = json.loads(last)['servers']
            require(server['id'] == server_id, 'the wrong fixture server was returned')
            return '', 'list_mcp_tools', {'server_id': server['id']}
        if count and n == 5:
            tool, = json.loads(last)['tools']
            require(tool['name'] == tool_name, 'the advertised MCP tool was missing from discovery')
            return '', 'call_mcp_tool', {'server_id': server_id, 'tool': tool['name'], 'arguments': {}}
        summary = 'Verified 17 fixture releases.' if count else 'Verified an empty project MCP catalog.'
        if n == completion + 1:
            return '', 'work_finish', {'summary': summary}
        return summary, None, {}

    class Provider(QuietHTTP):
        def do_GET(self):
            self.json_reply(200, {'data': []})

        def do_POST(self):
            request = self.request_json()
            try:
                content, tool, args = model_turn(request)
            except (AssertionError, KeyError, IndexError, ValueError) as exc:
                errors.append(str(exc))
                content, tool, args = 'Fixture failed.', None, {}
            delta = {'role': 'assistant', 'content': content}
            if tool:
                delta['tool_calls'] = [{'index': 0, 'id': f'fixture-{sum(steps.values())}', 'type': 'function', 'function': {'name': tool, 'arguments': json.dumps(args)}}]
            self.send_response(200)
            self.send_header('Content-Type', 'text/event-stream')
            self.end_headers()
            for chunk in [{'choices': [{'index': 0, 'delta': delta}]}, {'choices': [{'index': 0, 'delta': {}, 'finish_reason': 'tool_calls' if tool else 'stop'}]}]:
                self.wfile.write(('data: ' + json.dumps(chunk) + '\n\n').encode())
            self.wfile.write(b'data: [DONE]\n\n')

    def run_worker(lake, title):
        base = '/api/projects/' + projects[title]
        count = title == count_title
        pilot = lake.api(base + '/superagent', 'POST', {})['routerSessionId']
        lake.api('/api/sessions/' + pilot + '/messages', 'POST', {'text': title})
        answered, approved = set(), set()
        until = time.monotonic() + 100
        while time.monotonic() < until:
            require(not errors, '; '.join(errors))
            workers = lake.api(base + '/superagent')['workers']
            if not workers:
                time.sleep(.1)
                continue
            require(len(workers) == 1, 'duplicate Worker')
            worker = workers[0]
            sid = worker['sessionId']
            view = lake.snapshot(sid)
            if count and title not in retries and worker['task']['state'] == 'paused' and worker['assignmentState'] == 'parked':
                proposal = json.loads(rows('SELECT data FROM native_work_goals WHERE id=? AND session_id=?', (worker['task']['taskId'], sid))[0][0])
                require(not proposal.get('items') and not requests, 'the original proposal already executed')
                retries[title] = {'taskId': worker['task']['taskId'], 'sessionId': sid,
                                  'modelRounds': proposal['modelRounds'], 'deadlineAt': proposal['deadlineAt']}
                lake.api('/api/sessions/' + pilot + '/messages', 'POST', {'text': title})
                continue
            if count and title in retries:
                require(worker['task']['taskId'] == retries[title]['taskId'] and sid == retries[title]['sessionId'], 'retry replaced the original task or Worker')
            question = view.get('question')
            if question and question['id'] not in answered:
                answers = {}
                for item in question['questions']:
                    require(item['id'] in ('work_contract', 'manual_acceptance'), 'unexpected fixture question ' + item['id'])
                    if item['id'] == 'manual_acceptance':
                        require(requests == [tool_name], 'manual acceptance preceded the single fixture call')
                        tool = 'call_mcp_tool' if count else 'list_mcp_servers'
                        evidence = rows("SELECT result FROM native_operations WHERE session_id=? AND tool=? AND status='succeeded'", (sid, tool))
                        require(len(evidence) == 1, 'missing or duplicate durable execution evidence')
                        if count:
                            require(marker in evidence[0][0], 'receipt missing from durable evidence')
                    choice = item['options'][0]
                    answers[item['id']] = [choice if isinstance(choice, str) else choice['label']]
                lake.api('/api/sessions/' + sid + '/ai/questionReply', 'POST', {'id': question['id'], 'answers': answers})
                answered.add(question['id'])
            for pending in view.get('pendingApprovals') or ([view['pending']] if view.get('pending') else []):
                if pending['id'] in approved:
                    continue
                call = pending['call']
                require(count and call['name'] == 'call_mcp_tool' and json.loads(call['arguments']) == {'server_id': server_id, 'tool': tool_name, 'arguments': {}}, 'unexpected operation approval')
                lake.api('/api/sessions/' + sid + '/ai/decision', 'POST', {'id': pending['id'], 'accept': True, 'confirmation': pending.get('confirmation', '')})
                approved.add(pending['id'])
            if worker['task']['state'] == 'completed' and worker['task']['acceptanceState'] == 'pass':
                if count:
                    goal = json.loads(rows('SELECT data FROM native_work_goals WHERE id=? AND session_id=?', (worker['task']['taskId'], sid))[0][0])
                    require(goal['modelRounds'] > retries[title]['modelRounds'] and goal['deadlineAt'] == retries[title]['deadlineAt'], 'retry reset task usage or extended its deadline')
                break
            if count and worker['task']['state'] == 'paused' and not answered:
                time.sleep(.1)
                continue
            require(worker['task']['state'] not in ('failed', 'blocked', 'paused'), 'worker stalled: ' + str(worker['task']))
            time.sleep(.1)
        else:
            raise AssertionError('timed out at fixture steps ' + str(steps))
        require(len(answered) == 2, 'original task contract or independent acceptance missing')
        require(len(approved) == int(count), 'unexpected number of operation approvals')
        return sid

    env = {key: value for key, value in os.environ.items() if not key.startswith('LAKE_')}
    with serve(MCP) as mcp_url, serve(Provider) as provider_url:
        lake = Lake(binary, home, env, native=native)
        try:
            identity = lake.api('/api/superagent/lifecycle')
            require(Path(identity['home']).resolve() == home.resolve() and identity['pid'] == lake.runtime['pid'], 'wrong fixture backend')
            lake.api('/api/settings/model', 'PUT', {'url': provider_url, 'name': 'mcp-fixture', 'protocol': 'openai'})
            for title in (count_title, catalog_title):
                projects[title] = lake.api('/api/projects', 'POST', {'name': title})['id']
            lake.api('/api/projects/' + projects[count_title] + '/security/mcp-inheritance', 'PUT',
                     {'actionId': 'enable-project-inheritance', 'expectedRevision': 0, 'enabled': True})
            server_id = lake.api('/api/settings/mcp', 'POST', {'name': 'release-fixture', 'enabled': True, 'transport': 'http', 'url': mcp_url})['id']
            workers = {run_worker(lake, title) for title in (count_title, catalog_title)}
            require(len(workers) == 2 and requests == [tool_name], 'fixture call was duplicated or Worker session reused')
            require(not rows('SELECT 1 FROM security_mcp_bindings'), 'unexpected materialized per-server binding')
            return {'workerCount': len(workers), 'optedOutServerCount': 0, 'assetRefs': [], 'mcpCalls': len(requests),
                    'resumedOriginalProposal': count_title in retries, 'manualBindings': 0, 'humanQuestions': 4, 'operationApprovals': 1, 'verifiedReceipt': True}
        finally:
            try:
                if native:
                    lake.api('/api/superagent/lifecycle', 'POST', {'action': 'drain'})
            finally:
                lake.stop()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--binary', type=Path, required=True)
    parser.add_argument('--native', type=Path, help='installed Lake Dev executable, using its bundled backend')
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    binary = args.binary.resolve(strict=True)
    if args.native:
        bundled = args.native.resolve(strict=True).parents[1] / 'Resources/lake'
        require(binary.samefile(bundled), '--binary must identify the bundled Lake Dev backend')
    if sys.platform == 'darwin':
        subprocess.run(['codesign', '--verify', '--strict', str(binary)], check=True)
    with tempfile.TemporaryDirectory(prefix='lake-super-mcp-dev.') as directory:
        report = exercise(binary, Path(directory), args.native)
    report.update(
        passed=True, native=bool(args.native),
        sourceDirty=bool(subprocess.check_output(['git', 'status', '--porcelain'], text=True).strip()),
        binarySHA256=hashlib.sha256(binary.read_bytes()).hexdigest(),
        testedSHA=subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip(),
    )
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report))


if __name__ == '__main__':
    main()
