#!/usr/bin/env python3
"""Signed Dev regression: resume one blocked task and read metadata, keeping unknown SSH risk."""
import argparse
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import socketserver
import sqlite3
import struct
import subprocess
import tempfile
import threading
import time

from dev_acceptance import Lake, require, wait_for
from verify_superagent_mcp_dev import QuietHTTP, serve


@contextmanager
def mysql_fixture():
    queries = []

    class Handler(socketserver.BaseRequestHandler):
        def handle(self):
            self.request.settimeout(10)

            def packet(seq, data):
                self.request.sendall(len(data).to_bytes(3, 'little') + bytes([seq]) + data)

            def read_exact(size):
                data = b''
                while len(data) < size:
                    chunk = self.request.recv(size - len(data))
                    if not chunk:
                        raise EOFError()
                    data += chunk
                return data

            def read():
                header = read_exact(4)
                size = int.from_bytes(header[:3], 'little')
                require(size <= 8192, 'oversized fixture request')
                return read_exact(size)

            def string(value):
                value = value.encode()
                return bytes([len(value)]) + value

            capabilities = 1 | 4 | 8 | 512 | 8192 | 32768 | 1 << 17 | 1 << 19
            hello = b'\x0a8.4.0-fixture\x00' + struct.pack('<I', 1) + b'12345678\x00'
            hello += struct.pack('<H', capabilities & 65535) + b'\x2d\x02\x00'
            hello += struct.pack('<H', capabilities >> 16) + b'\x15' + bytes(10)
            hello += b'abcdefghijkl\x00mysql_native_password\x00'
            ok = b'\x00\x00\x00\x02\x00\x00\x00'
            try:
                packet(0, hello)
                read()
                packet(2, ok)
                while True:
                    command = read()
                    if not command or command[0] == 1:
                        return
                    require(command[0] == 3, 'unregistered MySQL command')
                    query = command[1:].decode()
                    queries.append(query)
                    if query.startswith('SELECT ') or query.startswith('SHOW CREATE TABLE '):
                        ddl = query.startswith('SHOW CREATE TABLE ')
                        columns = ('Table', 'Create Table') if ddl else ('name', 'type')
                        values = ('sample', 'CREATE TABLE `sample` (`id` int)') if ddl else ('fixture', 'schema')
                        packet(1, bytes([2]))
                        for i, name in enumerate(columns):
                            column = b''.join(string(x) for x in ('def', '', '', '', name, name))
                            packet(i + 2, column + bytes([12, 45, 0, 255, 0, 0, 0, 253, 0, 0, 0, 0, 0]))
                        packet(4, bytes([254, 0, 0, 2, 0]))
                        packet(5, b''.join(string(x) for x in values))
                        packet(6, bytes([254, 0, 0, 2, 0]))
                    else:
                        require(query in ('START TRANSACTION READ ONLY', 'SET SESSION MAX_EXECUTION_TIME=5000', 'ROLLBACK'), 'unexpected fixture SQL')
                        packet(1, ok)
            except (EOFError, ConnectionError):
                pass

    class Server(socketserver.ThreadingTCPServer):
        daemon_threads = True

    with Server(('127.0.0.1', 0), Handler) as server:
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            yield server.server_address[1], queries
        finally:
            server.shutdown()
            thread.join()


def exercise(binary, home):
    env = {k: v for k, v in os.environ.items() if not k.startswith('LAKE_')}
    # Seed synthetic history only while this disposable Home has no owner.
    initial = Lake(binary, home, env)
    initial.stop()
    ledger = home / 'web-agent/adk/sessions.sqlite'
    with sqlite3.connect(ledger) as db:
        db.execute("INSERT INTO native_operations(id,session_id,tool,status,risk,handle,started_at) VALUES(?,?,?,?,?,?,?)",
                   ('old-ssh', 'old-session', 'open_ssh_terminal', 'unknown', 'dangerous', 'original-handle', '2026-11-01 00:00:00+00:00'))
        db.commit()

    def rows(sql, args=()):
        with sqlite3.connect(f'file:{ledger}?mode=ro', uri=True) as db:
            return db.execute(sql, args).fetchall()

    original = 'Inspect the fixture database metadata'
    followup = 'Retry the same metadata task using current bounded reads'
    state = {'worker_calls': 0}
    errors = []

    def model_turn(request):
        tools = {tool['function']['name'] for tool in request.get('tools', [])}
        if not tools:
            return 'Keep the original task and recorded operations.', None, {}
        if 'route_work' in tools:
            pending = rows("SELECT id,payload FROM superagent_events WHERE project_id=? AND source_kind='user' AND disposition='pending' ORDER BY rowid", (state['project'],))
            if not pending:
                return 'Assigned to the database specialist.', None, {}
            event, payload = pending[0]
            workers = rows('SELECT task_id FROM superagent_workers WHERE project_id=?', (state['project'],))
            args = {'event_id': event, 'part_key': 'metadata', 'quote': original if original in payload else followup, 'reason': 'one original metadata task'}
            if workers:
                args.update(action='followup', task_id=workers[0][0])
            else:
                args.update(action='create', title=original, role_key='database specialist')
            return '', 'route_work', args
        state['worker_calls'] += 1
        n = state['worker_calls']
        if n == 1:
            return '', 'work_begin', {'title': original, 'asset_refs': [state['alias']], 'items': [{'id': 'inspect', 'title': original}]}
        goal = json.loads(rows('SELECT data FROM native_work_goals WHERE session_id IN (SELECT session_id FROM superagent_workers WHERE project_id=?)', (state['project'],))[0][0])
        item = goal['items'][0]['id']
        if n in (2, 6):
            return '', 'work_update', {'item_id': item, 'status': 'running'}
        if n == 3:
            return '', 'work_update', {'item_id': item, 'status': 'blocked', 'reason': 'Historical metadata restriction; current eligibility has not been checked.'}
        if n == 4:
            return 'The first attempt was blocked.', None, {}
        if n == 5:
            messages = '\n'.join(str(m.get('content', '')) for m in request['messages'])
            require('Prior blocker prose is historical' in messages, 'current followup lost recheck guidance')
            return '', 'work_read', {}
        if n == 7:
            return '', 'list_db_objects', {'asset_ref': state['alias'], 'query_type': 'database'}
        if n == 8:
            require('fixture' in str(request['messages'][-1]), 'metadata did not reach the Worker')
            return '', 'db_table_ddl', {'asset_ref': state['alias'], 'schema': 'app', 'table': 'sample'}
        if n == 9:
            require('CREATE TABLE' in str(request['messages'][-1]), 'DDL did not reach the Worker')
            return '', 'work_update', {'item_id': item, 'status': 'completed', 'evidence_ids': ['metadata-call-7', 'metadata-call-8']}
        if n == 10:
            return '', 'work_finish', {'summary': 'Current bounded reads returned the fixture catalog and sample table definition.'}
        return 'Current metadata reads succeeded.', None, {}

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
                delta['tool_calls'] = [{'index': 0, 'id': f"metadata-call-{state['worker_calls']}" if tool != 'route_work' else f'route-{time.monotonic_ns()}', 'type': 'function', 'function': {'name': tool, 'arguments': json.dumps(args)}}]
            self.send_response(200)
            self.send_header('Content-Type', 'text/event-stream')
            self.end_headers()
            for chunk in ({'choices': [{'index': 0, 'delta': delta}]}, {'choices': [{'index': 0, 'delta': {}, 'finish_reason': 'tool_calls' if tool else 'stop'}]}):
                self.wfile.write(('data: ' + json.dumps(chunk) + '\n\n').encode())
            self.wfile.write(b'data: [DONE]\n\n')

    with mysql_fixture() as (port, queries), serve(Provider) as provider:
        lake = Lake(binary, home, env)
        try:
            state['project'] = project = lake.api('/api/projects', 'POST', {'name': 'Disposable metadata retry regression'})['id']
            asset = lake.api('/api/projects/' + project + '/resources', 'POST', {'name': 'Loopback fixture', 'kind': 'database', 'settings': {'driver': 'mysql', 'host': '127.0.0.1', 'port': port, 'database': 'fixture', 'username': 'fixture', 'tls': False}})['id']
            state['alias'] = 'a_' + hashlib.sha256(asset.encode()).hexdigest()[:16]
            lake.api('/api/settings/model', 'PUT', {'url': provider, 'name': 'metadata-fixture', 'protocol': 'openai'})
            pilot = lake.api('/api/projects/' + project + '/superagent', 'POST', {})['routerSessionId']
            lake.api('/api/sessions/' + pilot + '/ai/configure', 'POST', {'silentReadSQL': True, 'contextBudgetMode': 'manual', 'contextWindow': 100000, 'maxSteps': 30})
            answered = set()

            def observe(expected):
                require(not errors, '; '.join(errors))
                workers = lake.api('/api/projects/' + project + '/superagent')['workers']
                if not workers:
                    return None
                require(len(workers) == 1, 'retry created a replacement Worker')
                worker = workers[0]
                view = lake.snapshot(worker['sessionId'])
                require(not view.get('pendingApprovals') and not view.get('pending'), 'read unexpectedly requires operation approval')
                question = view.get('question')
                if question and question['id'] not in answered:
                    answers = {}
                    for item in question['questions']:
                        require(item['id'] in ('work_contract', 'manual_acceptance'), 'unexpected question')
                        if item['id'] == 'manual_acceptance':
                            require(len(rows("SELECT id FROM native_operations WHERE tool IN ('list_db_objects','db_table_ddl') AND status='succeeded'")) == 2, 'acceptance preceded actual reads')
                        option = item['options'][0]
                        answers[item['id']] = [option if isinstance(option, str) else option['label']]
                    lake.api('/api/sessions/' + worker['sessionId'] + '/ai/questionReply', 'POST', {'id': question['id'], 'answers': answers})
                    answered.add(question['id'])
                parked = rows("SELECT state FROM superagent_assignments WHERE worker_id=?", (worker['id'],)) == [('parked',)]
                return worker if worker['task']['state'] == expected and parked else None

            lake.api('/api/sessions/' + pilot + '/messages', 'POST', {'text': original})
            before = wait_for(lambda: observe('blocked'), 90)
            require(not queries, 'historical blocker fixture dispatched database I/O')
            lake.api('/api/sessions/' + pilot + '/messages', 'POST', {'text': followup})
            after = wait_for(lambda: observe('completed'), 90)
            require(before['task']['taskId'] == after['task']['taskId'], 'retry replaced the canonical task')
            operations = rows("SELECT status,security_descriptor FROM native_operations WHERE tool IN ('list_db_objects','db_table_ddl') ORDER BY rowid")
            require(len(operations) == 2 and all(status == 'succeeded' for status, _ in operations), 'metadata evidence did not succeed')
            for _, descriptor in operations:
                descriptor = json.loads(descriptor)
                require(descriptor.get('proof') == 'structured' and descriptor.get('scope', {}).get('probeId', '').startswith('sql.metadata.'), 'metadata did not use original structured permit')
            require(rows("SELECT status,handle,risk_resolved_at FROM native_operations WHERE id='old-ssh'") == [('unknown', 'original-handle', None)], 'unknown SSH effect was cleared')
            require(queries.count('START TRANSACTION READ ONLY') == 2 and queries.count('ROLLBACK') == 2 and not any('COMMIT' in q for q in queries), 'wire transaction boundary failed')
            return {'sameTaskAndWorker': True, 'metadataOperations': 2, 'readOnlyTransactions': 2, 'rollbacks': 2, 'unknownSSHPreserved': True, 'operationApprovals': 0, 'acceptanceState': after['task']['acceptanceState'], 'provider': 'scripted loopback, not a model intelligence benchmark', 'realDatabaseComparison': 'not executed'}
        finally:
            lake.stop()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--binary', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    binary = args.binary.resolve(strict=True)
    subprocess.run(['codesign', '--verify', '--strict', str(binary)], check=True)
    with tempfile.TemporaryDirectory(prefix='lake-metadata-dev.') as directory:
        report = exercise(binary, Path(directory))
    origin_file = binary.parent / 'build-origin.json'
    origin = json.loads(origin_file.read_text()) if origin_file.exists() else {}
    report.update(passed=True, testedSHA=origin.get('gitHead'), buildDirty=origin.get('dirty'), fixtureSHA=subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip(), sourceDirty=bool(subprocess.check_output(['git', 'status', '--porcelain'], text=True).strip()), binarySHA256=hashlib.sha256(binary.read_bytes()).hexdigest())
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report))


if __name__ == '__main__':
    main()
