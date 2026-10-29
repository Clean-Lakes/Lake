#!/usr/bin/env python3
"""Exercise signed Dev work continuity with isolated data and a fake model.

Starts only a tiny fixture command; never loads the user's configured model,
credentials or release tasks. Existing Lake/Dev processes remain untouched.
"""
import argparse
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from dev_acceptance import Lake, require, wait_for


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--binary', type=Path, default=Path(__file__).resolve().parent.parent / 'bin/lake')
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    binary = args.binary.resolve(strict=True)
    signed = sys.platform == 'darwin'
    if signed:
        subprocess.run(['codesign', '--verify', '--strict', str(binary)], check=True)
    calls, auxiliary = [], []

    class Model(BaseHTTPRequestHandler):
        def log_message(self, *unused):
            pass

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            messages = body['messages']
            (calls if body.get('tools') else auxiliary).append(messages)
            text, tool = '', None
            if not body.get('tools'):
                text = '合成测试任务'
            elif messages[-1].get('role') == 'user' and 'fixture-independent' in str(messages[-1].get('content')):
                text = '独立话题已完成。'
            elif len(calls) == 1:
                tool = {'id': 'original-signed-job', 'type': 'function', 'function': {
                    'name': 'shell', 'arguments': json.dumps({'command': 'sleep 0.3; printf TASK_CONTINUITY_OK', 'run_in_background': True})}}
            elif len(calls) == 2:
                text = '已启动，等待实际结果。'
            else:
                require('host_external_observation' in json.dumps(messages), 'original external result was not restored')
                tool = {'id': 'original-signed-finish', 'type': 'function', 'function': {
                    'name': 'work_finish', 'arguments': json.dumps({'summary': '已核对原命令完成，没有重复执行。'})}}
            delta = {'tool_calls': [dict(index=0, **tool)]} if tool else {'content': text}
            result = {'choices': [{'index': 0, 'delta': delta, 'finish_reason': 'tool_calls' if tool else 'stop'}],
                      'usage': {'prompt_tokens': 100, 'completion_tokens': 20, 'total_tokens': 120}}
            self.send_response(200)
            self.send_header('Content-Type', 'text/event-stream')
            self.end_headers()
            self.wfile.write(('data: ' + json.dumps(result) + '\n\ndata: [DONE]\n\n').encode())

    server = ThreadingHTTPServer(('127.0.0.1', 0), Model)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        with tempfile.TemporaryDirectory(prefix='lake-work-acceptance.') as directory:
            home = Path(directory)
            os.chmod(home, 0o700)
            env = {key: value for key, value in os.environ.items() if not key.startswith('LAKE_')}
            lake = None
            try:
                lake = Lake(binary, home, env)
                require(not lake.api('/api/bootstrap')['modelConfigured'], 'fresh Home unexpectedly has a model')
                project = lake.api('/api/projects', 'POST', {'name': 'Synthetic work acceptance'})['id']
                lake.api('/api/projects/' + project + '/sre', 'PUT', {'enabled': False})
                lake.api('/api/settings/model', 'PUT', {'url': f'http://127.0.0.1:{server.server_address[1]}/v1/chat/completions', 'name': 'fixture', 'apiKey': None})
                session = lake.session(project, 'Signed work continuity')
                lake.api('/api/sessions/' + session + '/messages', 'POST', {'text': 'fixture-long-work: complete the original background job'})

                def parked():
                    full = lake.api('/api/sessions/' + session + '/snapshot')
                    view = lake.snapshot(session)
                    return view if view.get('status') == 'waiting_external' and full['session']['status'] == 'completed' else None

                before = wait_for(parked)
                require(len(calls) == 2, 'waiting invocation did not release without model polling')
                goal = before['workGoals'][0]
                wait_for(lambda: any(card.get('type') == 'shell' and card.get('status') == 'completed' for card in lake.snapshot(session).get('cards', [])))
                lake.stop()
                lake = None
                lake = Lake(binary, home, env)
                independent = lake.send_and_finish(session, 'fixture-independent')
                require(independent['rootTurnId'] != goal['originRootTurnId'], 'new topic reused old identity')

                def finished():
                    view = lake.snapshot(session)
                    current = next((item for item in view.get('workGoals', []) if item['id'] == goal['id']), {})
                    return view if current.get('status') == 'completed' and any(card.get('id') == 'work-report-' + goal['id'] for card in view.get('cards', [])) else None

                final = wait_for(finished, 50)
                require(final['rootTurnId'] == independent['rootTurnId'] and final['status'] == 'completed', 'old goal overwrote foreground')
                require(len(calls) == 4, 'extra main model polling or duplicate resumption')
                with sqlite3.connect(home / 'web-agent/adk/sessions.sqlite') as database:
                    count = database.execute("SELECT count(*) FROM native_operations WHERE call_id='original-signed-job'").fetchone()[0]
                require(count == 1, 'original operation replayed')
                result = {'status': 'passed', 'signedBackend': signed, 'isolatedHome': True, 'restartRecovered': True,
                          'newTopicPreserved': True, 'modelRequests': len(calls), 'auxiliaryNamingRequests': len(auxiliary), 'originalDispatches': count}
            finally:
                if lake:
                    lake.stop()
    finally:
        server.shutdown()
        server.server_close()
    text = json.dumps(result, ensure_ascii=False, indent=2) + '\n'
    if args.output:
        args.output.write_text(text)
    print(text, end='')


if __name__ == '__main__':
    main()
