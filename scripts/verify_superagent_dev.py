#!/usr/bin/env python3
"""Run a signed Lake Super-agent fixture in a private, disposable Home.

Uses two real read-only files and a loopback synthetic provider. Real human
protocol answers are supplied only for these explicitly isolated test targets.
Never imports production credentials or enables operational Memory V2.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import subprocess
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from dev_acceptance import Lake, require, wait_for


def unit_matrix(path):
    """Record observed boundary tests, not blanket approval of a scenario."""
    checks = {}
    if path:
        for line in path.read_text().splitlines():
            try:
                event = json.loads(line)
            except ValueError:
                continue
            if event.get('Test') and event.get('Action') in ('pass', 'fail'):
                checks[event['Test']] = event['Action']
    patterns = [
        r'SuperRouterRunsOnlyOfficial', r'SuperLegacy|SuperStore', r'SuperTaskProjection',
        r'SuperEventConcurrent|SuperEventRejects', r'SuperSubscriptions|SuperObserverCannot',
        r'SuperInboxConsumption', r'SuperOutbox|SuperPilotReport', r'SuperRouterSplits',
        r'SuperRouterRejects|SuperRouterRunsOnlyOfficial', r'SuperWorkerUsesOriginal|SuperWorkflowReal',
        r'SuperRouterObjectScope', r'SuperChildren', r'SuperAssignment|SuperBudget',
        r'WorkObserver|WorkRecovery|Security.*Resume', r'SuperResourceConflict',
        r'SuperMemoryPreserves|NaturalMemorySnapshot', r'SuperMemoryPreserves',
        r'SuperMemoryReferences|Memory.*(Outbox|Duplicate|Snapshot)',
        r'NaturalRecallRevocation|MemoryV2ForegroundRevokes', r'SuperProjectHas|SuperWorkflowReal',
        r'SecurityScheduleOccurrence|SuperWorkflowDefinition', r'SuperLegacy|SuperCutover',
        r'^$', r'SuperRecovery|SuperHumanRecovery', r'SuperWatchdog|SuperRouterFailures',
        r'SuperLifecycle',
    ]
    result = []
    for number, pattern in enumerate(patterns, 1):
        observed = {name: state for name, state in checks.items() if re.search(pattern, name)}
        result.append({'case': f'TEST-{number:03}', 'unitBoundaryEvidence': observed, 'status': 'unit_evidence' if observed and all(state == 'pass' for state in observed.values()) else 'not_verified', 'fullScenarioClaimed': False})
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--binary', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--native', type=Path)
    parser.add_argument('--hold-seconds', type=int, default=0, choices=range(1801))
    parser.add_argument('--inspection-finished-file', type=Path, help='owned test marker that ends the optional visual inspection early')
    parser.add_argument('--ui-detached-file', type=Path, help='owned test marker set after quitting the native UI; verify surviving kernel and reopen the same isolated Home')
    parser.add_argument('--go-results', type=Path, help='optional complete go test -json log')
    parser.add_argument('--exercise-missing-role', action='store_true', help='omit role_key once, verify actionable feedback and repair the same original event part')
    parser.add_argument('--exercise-missing-target', action='store_true', help='omit asset_ref once per Worker and verify target repair before the actual read')
    parser.add_argument('--exercise-missing-attempt', action='store_true', help='try a read before starting an item and verify the original attempt protocol repairs it')
    parser.add_argument('--inherit-project-access', action='store_true', help='use the existing project catalog and permissions without writing a separate project policy')
    args = parser.parse_args()
    binary = args.binary.resolve(strict=True)
    if os.uname().sysname == 'Darwin':
        subprocess.run(['codesign', '--verify', '--strict', str(binary)], check=True)
    state, lock = {'router': 0, 'calls': {}, 'db': None}, threading.Lock()

    def query(sql, parameters=()):
        with sqlite3.connect('file:' + str(state['db']) + '?mode=ro', uri=True) as db:
            return db.execute(sql, parameters).fetchall()

    class Provider(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_GET(self):
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(b'{"data":[]}')

        def do_POST(self):
            request = json.loads(self.rfile.read(int(self.headers.get('Content-Length', 0))))
            names = {tool['function']['name'] for tool in request.get('tools', [])}
            content, tool, payload = '', None, {}
            with lock:
                if 'route_work' in names:
                    state['router'] += 1
                    n = state['router']
                    if args.exercise_missing_role and n == 2:
                        require('requires both title and role_key' in json.dumps(request.get('messages', [])), 'missing role did not produce actionable tool feedback')
                        require(query('SELECT count(*) FROM superagent_workers')[0][0] == 0, 'invalid routing arguments created a Worker')
                        state['routingArgumentRepairVerified'] = True
                    route_number = n - 1 if args.exercise_missing_role and n >= 2 else n
                    if route_number <= 2:
                        event = query("SELECT id FROM superagent_events WHERE source_kind='user' ORDER BY received_at LIMIT 1")[0][0]
                        label = 'A' if route_number == 1 else 'B'
                        tool, payload = 'route_work', {'event_id': event, 'part_key': 'marker-' + label, 'action': 'create', 'title': 'Read marker ' + label, 'role_key': 'reader', 'quote': 'Read marker ' + label, 'reason': 'Independent actual user deliverable'}
                        if args.exercise_missing_role and n == 1:
                            del payload['role_key']
                    else:
                        content = '两项只读工作已分别交给专员；原要求与验收条件保留。'
                    key = 'router'
                elif not names:
                    key, n = 'summary', 0
                    content = 'Preserve original goals, actual file evidence, human acceptance and unresolved outcomes. No new I/O is authorized.'
                else:
                    text = '\n'.join(str(message.get('content', '')) for message in request.get('messages', []))
                    match = re.search(r'\[ASSIGNED DELIVERABLE\]\s*Read marker ([AB])', text)
                    require(match is not None, 'Worker lost its exact assigned original deliverable')
                    key = match.group(1)
                    state['lastToolResults' + key] = [message.get('content') for message in request.get('messages', []) if message.get('role') == 'tool'][-6:]
                    state['calls'][key] = state['calls'].get(key, 0) + 1
                    n = state['calls'][key]
                    sequence = n - 1 if args.exercise_missing_attempt and n >= 3 else n
                    if args.exercise_missing_attempt and n == 3:
                        require('goal/step/attempt binding required: read the current goal with work_read' in text, 'missing attempt did not produce actionable feedback')
                        state['attemptRepair' + key] = True
                    if args.exercise_missing_target and sequence == 4:
                        require('TARGET_REQUIRED: specify asset_ref from list_assets' in text, 'missing resource target did not produce actionable feedback')
                        state['targetRepair' + key] = True
                    step = sequence - 1 if args.exercise_missing_target and sequence >= 4 else sequence
                    if args.exercise_missing_attempt and n == 2:
                        tool, payload = 'read', {'asset_ref': state['alias'], 'path': str(state['readable'] / ('marker-' + key + '.txt'))}
                    elif step == 1:
                        tool, payload = 'work_begin', {'title': 'Read marker ' + key, 'items': [{'id': 'inspect', 'title': 'Read and independently verify marker ' + key}], 'asset_refs': [state['alias']]}
                    elif step in (2, 4):
                        rows = query("SELECT g.data FROM native_work_goals g JOIN superagent_workers w ON w.task_id=g.id WHERE json_extract(g.data,'$.title')=? AND w.parent_worker_id=''", ('Read marker ' + key,))
                        goal = json.loads(rows[0][0])
                        tool, payload = 'work_update', {'item_id': goal['items'][0]['id'], 'status': 'running' if step == 2 else 'completed'}
                    elif step == 3:
                        tool, payload = 'read', {'asset_ref': state['alias'], 'path': str(state['readable'] / ('marker-' + key + '.txt'))}
                        if args.exercise_missing_target and sequence == 3:
                            del payload['asset_ref']
                            payload['runtime'] = 'local'
                    elif step == 5:
                        tool, payload = 'work_finish', {'summary': 'The original marker was read and independently verified.'}
                    else:
                        content = '原文件已读取，独立人工验收通过。'
            delta = {'role': 'assistant', 'content': content}
            if tool:
                delta['tool_calls'] = [{'index': 0, 'id': f'fixture-{key}-{n}', 'type': 'function', 'function': {'name': tool, 'arguments': json.dumps(payload)}}]
            self.send_response(200)
            self.send_header('Content-Type', 'text/event-stream')
            self.end_headers()
            for chunk in ({'choices': [{'index': 0, 'delta': delta, 'finish_reason': None}]}, {'choices': [{'index': 0, 'delta': {}, 'finish_reason': 'tool_calls' if tool else 'stop'}]}):
                self.wfile.write(('data: ' + json.dumps(chunk) + '\n\n').encode())
            # This synthetic provider defines one fixture token per four JSON
            # characters. Report usage so completed responses settle their
            # reservations; absent usage correctly retains the worst-case cost.
            prompt_tokens = max(1, (len(json.dumps(request)) + 3) // 4)
            completion_tokens = max(1, (len(json.dumps(delta)) + 3) // 4)
            usage = {'choices': [], 'usage': {'prompt_tokens': prompt_tokens, 'completion_tokens': completion_tokens, 'total_tokens': prompt_tokens + completion_tokens}}
            self.wfile.write(('data: ' + json.dumps(usage) + '\n\n').encode())
            self.wfile.write(b'data: [DONE]\n\n')
            self.wfile.flush()

    provider = ThreadingHTTPServer(('127.0.0.1', 0), Provider)
    threading.Thread(target=provider.serve_forever, daemon=True).start()
    env = {key: value for key, value in os.environ.items() if not key.startswith('LAKE_')}
    report = {'passed': False, 'binarySHA256': hashlib.sha256(binary.read_bytes()).hexdigest(), 'provider': 'loopback synthetic fixture', 'providerUsage': 'synthetic four-JSON-character fixture tokens, not real model billing', 'native': bool(args.native), 'testedSHA': subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip(), 'sourceDirty': bool(subprocess.check_output(['git', 'status', '--porcelain'], text=True).strip()), 'scenarios': unit_matrix(args.go_results)}
    try:
        with tempfile.TemporaryDirectory(prefix='lake-superagent-dev.') as directory:
            root = Path(directory)
            root.chmod(0o700)
            home, readable = root / 'home', root / 'readable'
            home.mkdir(mode=0o700)
            readable.mkdir(mode=0o700)
            for label in ('A', 'B'):
                marker = readable / ('marker-' + label + '.txt')
                marker.write_text('LAKE_SUPER_READ_ONLY_' + label + '\n')
                marker.chmod(0o600)
            state.update(db=home / 'web-agent/adk/sessions.sqlite', readable=readable)
            lake = Lake(binary, home, env, native=args.native)
            try:
                project = lake.api('/api/projects', 'POST', {'name': 'Super-agent isolated acceptance'})['id']
                domain = lake.api('/api/projects/' + project + '/superagent', 'POST', {})
                pilot = domain['routerSessionId']
                snapshot = lake.api('/api/sessions/' + pilot + '/snapshot')
                resource = next(resource['id'] for resource in snapshot['resources'] if resource['kind'] == 'local')
                state['alias'] = 'a_' + hashlib.sha256(resource.encode()).hexdigest()[:16]
                lake.api('/api/settings/model', 'PUT', {'url': f'http://127.0.0.1:{provider.server_port}', 'name': 'isolated-superagent-fixture', 'protocol': 'openai'})
                lake.api('/api/sessions/' + pilot + '/ai/configure', 'POST', {'contextBudgetMode': 'manual', 'contextWindow': 64000, 'maxSteps': 20})
                previous = lake.api('/api/projects/' + project + '/security/policy')
                revision = previous.get('policy', {}).get('Revision', 0)
                if args.inherit_project_access:
                    inherited = previous.get('policy', {})
                    require(inherited.get('Mode') == 'legacy' and resource in inherited.get('ResourceIDs', []), 'original project access was not inherited')
                    report['projectAccess'] = 'inherited catalog and original permissions; no policy PUT'
                else:
                    lake.api('/api/projects/' + project + '/security/policy', 'PUT', {'actionId': 'isolated-read-policy', 'expectedRevision': revision, 'policy': {'schemaVersion': 1, 'mode': 'restricted', 'resourceIDs': [resource], 'rules': [{'capability': 'file.read', 'effect': 'allow', 'limits': {'FileRoots': [str(readable)]}}, {'capability': 'local.execute', 'effect': 'allow'}]}})
                lake.api('/api/sessions/' + pilot + '/messages', 'POST', {'text': 'Read marker A; Read marker B. Read only, do not modify files. Preserve separate goals and verify each result.', 'resourceIds': [resource]})
                answered, workers = set(), []
                for _ in range(900):
                    workspace = lake.api('/api/projects/' + project + '/superagent')
                    workers = workspace['workers']
                    for worker in workers:
                        sid = worker['sessionId']
                        view = lake.snapshot(sid)
                        question = view.get('question')
                        if question and question['id'] not in answered:
                            answers = {}
                            for item in question['questions']:
                                labels = [option if isinstance(option, str) else option['label'] for option in item['options']]
                                if item['id'] == 'manual_acceptance':
                                    operations = query("SELECT status,result FROM native_operations WHERE session_id=? AND tool='read'", (sid,))
                                    require(len(operations) == 1 and operations[0][0] == 'succeeded' and 'LAKE_SUPER_READ_ONLY_' in operations[0][1], 'human verification preceded actual file evidence')
                                answers[item['id']] = [labels[0]]
                            lake.api('/api/sessions/' + sid + '/ai/questionReply', 'POST', {'id': question['id'], 'answers': answers})
                            answered.add(question['id'])
                    if len(workers) == 2 and all(worker['task']['state'] in ('blocked', 'failed') for worker in workers):
                        raise AssertionError('Workers blocked: ' + json.dumps({'toolResults': {label: state.get('lastToolResults' + label) for label in ('A', 'B')}, 'goals': [json.loads(row[0]) for row in query('SELECT data FROM native_work_goals')], 'operations': query('SELECT tool,status,result FROM native_operations')}, ensure_ascii=False))
                    if len(workers) == 2 and all(worker['task']['state'] == 'completed' and worker['task']['acceptanceState'] == 'pass' for worker in workers):
                        break
                    time.sleep(0.1)
                else:
                    errors = {worker['sessionId']: [card.get('content', '') for card in lake.snapshot(worker['sessionId']).get('cards', []) if card.get('type') == 'error'] for worker in workers}
                    raise AssertionError('Super-agent fixture did not close both canonical goals: ' + json.dumps({'workers': workers, 'modelCalls': state['calls'], 'errors': errors}, ensure_ascii=False))
                require(len({worker['task']['taskId'] for worker in workers}) == 2 and len({worker['sessionId'] for worker in workers}) == 2, 'task context was shared')
                require(query("SELECT count(*) FROM native_operations WHERE tool='read' AND status='succeeded'")[0][0] == 2, 'read duplicated or missing')
                require(query("SELECT count(*) FROM native_operations WHERE tool IN ('write','edit','append','shell')")[0][0] == 0, 'readonly fixture performed an unsolicited mutation')
                wait_for(lambda: query("SELECT count(*) FROM superagent_outbox WHERE task_id<>'' AND state='delivered'")[0][0] >= 2)
                identity = lake.api('/api/superagent/lifecycle')
                require(Path(identity['home']).resolve() == home.resolve() and identity['pid'] == lake.runtime['pid'], 'wrong Home owner')
                report.update(runtimeAcceptance=True, tasks=2, distinctWorkerSessions=2, actualReads=2, humanQuestions=len(answered), pilotReportsDelivered=True, currentKernelPIDVerified=True, memoryTaskKnowledge='unavailable_by_design', externalBuildReadProfile='unavailable', windows='not_run', sleepAndPowerLoss='not_run')
                if args.exercise_missing_role:
                    require(state.get('routingArgumentRepairVerified'), 'routing argument repair was not exercised')
                    report['routingArgumentRepairVerified'] = True
                if args.exercise_missing_target:
                    require(state.get('targetRepairA') and state.get('targetRepairB'), 'both Workers must repair missing resource targets')
                    report['workerTargetRepairVerified'] = True
                if args.exercise_missing_attempt:
                    require(state.get('attemptRepairA') and state.get('attemptRepairB'), 'both Workers must repair the missing attempt')
                    report['workerAttemptRepairVerified'] = True
                args.output.parent.mkdir(parents=True, exist_ok=True)
                args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
                args.output.chmod(0o600)
                print('PASS: two Pilot tasks, isolated Workers, original plan confirmations, actual readonly files, independent goal acceptance and durable Pilot reports', flush=True)
                if args.hold_seconds:
                    print('Fixture Home for local UI inspection: ' + str(home), flush=True)
                    print('Fixture origin: ' + lake.runtime['origin'], flush=True)
                    until = time.monotonic() + args.hold_seconds
                    reopened = False
                    while time.monotonic() < until:
                        if args.ui_detached_file and args.ui_detached_file.exists() and not reopened:
                            require(args.native and lake.process.poll() is not None, 'the original native UI has not exited')
                            require(lake.api('/api/superagent/lifecycle')['pid'] == identity['pid'], 'UI exit stopped or replaced the kernel')
                            report['uiDetachedKernelSurvived'] = True
                            lake.process = subprocess.Popen([str(args.native), '--lake-home', str(home)], env=env, stdout=lake.log, stderr=lake.log)
                            reopened = True
                            require(lake.api('/api/superagent/lifecycle')['pid'] == identity['pid'], 'reopening replaced the original kernel')
                            print('REOPENED: native UI on the same isolated Home and kernel PID', flush=True)
                        if args.inspection_finished_file and args.inspection_finished_file.exists():
                            break
                        time.sleep(0.2)
                # Native UI inspection can explicitly drain the same known kernel.
                # Observe its exit rather than claiming the later CLI sent that request.
                def kernel_exited():
                    # Reap our CLI child: kill(pid, 0) also succeeds for a zombie.
                    if not args.native:
                        return lake.process.poll() is not None
                    try:
                        os.kill(identity['pid'], 0)
                        return False
                    except ProcessLookupError:
                        return True

                if not (home / 'web-agent/runtime.json').exists():
                    wait_for(kernel_exited, 30)
                    report['externalKernelExitObserved'] = True
                else:
                    lake.api('/api/superagent/lifecycle', 'POST', {'action': 'drain'})
                    report['explicitKernelDrainVerified'] = True
                wait_for(lambda: not (home / 'web-agent/runtime.json').exists(), 30)
            finally:
                lake.stop()
            report['passed'] = True
            args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    finally:
        provider.shutdown()
        provider.server_close()


if __name__ == '__main__':
    main()
