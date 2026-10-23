#!/usr/bin/env python3
"""Bounded two-request R5 trial against the already-running signed Lake Dev.

Uses a recoverable temporary project, constructed observations and one explicit
report preference. Does not change the global model, user assets or switches.
Both arms disable background learning/memory and online correction. No tools
are authorized. This checks the actual Dev HTTP/ADK path, not general benefit.
"""
import argparse
import hashlib
import json
import os
import pathlib
import subprocess
import sys
import time

from test_strategy_learning_dev import Lake, require


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--running-home', required=True, type=pathlib.Path)
    parser.add_argument('--report', required=True, type=pathlib.Path)
    parser.add_argument('--keep-for-ui', action='store_true')
    args = parser.parse_args()
    home = args.running_home.expanduser()
    require(home == pathlib.Path.home() / '.lake-dev' and not home.is_symlink(), 'fixed Dev Home only')
    require(not (home / 'web-agent').is_symlink(), 'Dev data must not be linked')
    repo = pathlib.Path(__file__).resolve().parent.parent
    origin = json.loads((repo / 'bin/lake-dev-run-origin.json').read_text())
    require(not origin['dirty'], 'signed clean build required')
    binary = repo / 'bin/lake'
    require(origin['backendSHA256'] == hashlib.sha256(binary.read_bytes()).hexdigest(), 'binary mismatch')
    subprocess.run(['codesign', '--verify', '--strict', str(binary)], check=True)
    lake = Lake.__new__(Lake)
    lake.home = home
    lake.runtime = json.loads((home / 'web-agent/runtime.json').read_text())
    comm = subprocess.check_output(['ps', '-p', str(lake.runtime['pid']), '-o', 'comm='], text=True).strip()
    require(comm == str(binary), 'running backend is not this signed build')
    model = lake.api('/api/bootstrap')
    require(model['modelConfigured'], 'Dev model not configured')
    project = lake.api('/api/projects', 'POST', {'name': 'R5 临时真实模型试用'})['id']
    base = '/api/projects/' + project + '/strategy'
    report = {'sourceCommit': origin['gitHead'], 'backendSHA256': origin['backendSHA256'],
              'model': model['modelName'], 'mode': 'running_signed_Dev_HTTP_ADK', 'status': 'running',
              'requestLimit': 2, 'projectId': project, 'onlineCorrection': False, 'backgroundLearning': False,
              'generalBenefit': 'inconclusive', 'trials': []}
    sid = ''
    try:
        lake.api('/api/projects/' + project + '/sre', 'PUT', {'enabled': False})
        lake.api('/api/projects/' + project + '/memory-settings', 'PATCH',
                 {'useEnabled': False, 'extractionEnabled': False, 'expectedRevision': 0})
        draft = {'expectedRevision': 0, 'title': 'R5 明确确认的试用简报偏好', 'kind': 'report_guidance',
                 'body': '本测试简报偏好：只用三个标题‘观察：’、‘判断：’、‘限制：’。保留当前事实和观察标识；不能推断恢复，不能授权任何工具操作。',
                 'applicability': {'profiles': ['core'], 'resourceKinds': ['local'], 'domainTags': []},
                 'reuse': {'keywords': ['简报'], 'general': False, 'validUntil': '', 'needsReview': False}}
        asset = lake.api(base + '/assets', 'POST', draft)['assetId']
        ref = lake.api(base + '/assets/' + asset + '/revisions/1')['value']['ref']
        lake.api(base + '/assets/' + asset + '/bindings', 'POST',
                 {'action': 'adopt', 'ref': ref, 'expectedRevision': 0, 'priority': 0, 'exclusionGroup': ''})
        question = ('请按我平时的方式生成简报。只使用这些完整的只读回放材料：'
                    'target=R5-DEMO; trace=R5-DEMO-OBS-20261023; requests=20; failed=1。'
                    '保留 target 和 trace，并说明资料只是回放；不代表实时状态或恢复。'
                    '不要调用任何工具、读写文件或访问网络。直接简短作答。')
        for arm in ['baseline', 'assets']:
            settings = lake.api(base + '/settings')['settings']
            lake.api(base + '/settings', 'PATCH', {'expectedRevision': settings['revision'],
                     'masterEnabled': True, 'applyEnabled': arm == 'assets', 'learnEnabled': False,
                     'correctEnabled': False, 'onlineCorrectEnabled': False, 'budget': settings['budget']})
            sid = lake.session(project, 'R5 同模型试用 ' + arm)
            lake.api('/api/sessions/' + sid + '/ai/configure', 'POST',
                     {'contextBudgetMode': 'manual', 'contextWindow': 64000, 'maxOutput': 2048, 'maxSteps': 1,
                      'denyLocalExecution': True, 'silentReadFiles': False, 'silentWriteFiles': False,
                      'silentCommands': False, 'silentReadSQL': False, 'silentTerminalCreation': False,
                      'blockUnreferencedAssets': True, 'reasoningEffort': 'low', 'reasoningModelId': model['modelId']})
            start = time.monotonic()
            view = lake.send_and_finish(sid, question)
            answer = '\n'.join(c.get('content', '') for c in view.get('cards', []) if c['type'] == 'message')
            history = lake.api(base + '/usage?sessionId=' + sid)['items']
            selected = history[0]['selected'] if history else []
            checks = {'completed': view['status'] == 'completed', 'onePreparedRequest': len(history) == 1,
                      'selection': selected == ([ref] if arm == 'assets' else []),
                      'factTrace': 'R5-DEMO-OBS-20261023' in answer and 'R5-DEMO' in answer,
                      'preferredHeadings': all(h in answer for h in ['观察：', '判断：', '限制：'])}
            report['trials'].append({'arm': arm, 'sessionId': sid, 'status': view['status'],
                  'durationMs': round((time.monotonic()-start)*1000), 'checks': checks,
                  'usage': view.get('usage', {}), 'selected': selected,
                  'requestIds': [r['requestId'] for r in history], 'answer': answer})
            require(checks['completed'] and checks['onePreparedRequest'] and checks['selection'], 'Dev trial stopped; no automatic retry')
            require(lake.api('/api/bootstrap')['modelId'] == model['modelId'], 'Dev model changed during pair')
        report['status'] = 'recorded'
        report['assetRef'] = ref
        report['proposalCount'] = len(lake.api(base + '/proposals')['items'])
        report['limitations'] = ['Two constructed tasks, not independent field evidence or statistical proof.',
                                 'Provider version/seed and monetary amount unavailable; no automatic adoption from results.']
    except Exception:
        report['status'] = 'stopped'
        raise
    finally:
        try:
            if sid and lake.snapshot(sid)['status'] in ('running', 'waiting_approval'):
                lake.api('/api/sessions/' + sid + '/ai/abort', 'POST', {})
                lake.finish(sid)
            if not args.keep_for_ui:
                lake.api('/api/navigation-delete', 'POST', {'kind': 'project', 'id': project})
                report['temporaryProjectArchived'] = True
        except Exception:
            report['temporaryProjectArchived'] = False
        args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
        os.chmod(args.report, 0o600)
    print(json.dumps({'status': report['status'], 'trials': len(report['trials']),
                      'sourceCommit': report['sourceCommit'], 'generalBenefit': 'inconclusive'}))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # Runtime payload, credentials and model error responses are never printed.
        print('R5 Dev trial stopped: ' + type(error).__name__, file=sys.stderr)
        sys.exit(1)
