import {useState} from 'react';
import {createRoot} from 'react-dom/client';
import type {SuperWorker} from '../../../shared/contracts';
import {SpecialistTaskMenu} from '../../src/SpecialistTaskMenu';
import {initializeFocusModality} from '../../src/focusModality';
import '../../src/theme.css';
import '../../src/specialistTaskMenu.css';

const params = new URLSearchParams(location.search);
if (params.has('dark')) document.documentElement.dataset.theme = 'dark';
initializeFocusModality();

const workers: SuperWorker[] = ['first', 'second'].map((id, index) => ({
  id: 'worker-' + id, sessionId: 'session-' + id, roleId: 'release', roleName: '发布专员',
  createdAt: index ? '2026-11-04T02:00:01Z' : '2026-11-04T01:00:00Z',
  assignmentState: index ? 'parked' : 'finished',
  task: {
    taskId: 'task-' + id, sessionId: 'session-' + id, title: '核对发布记录',
    state: index ? 'paused' : 'completed', acceptanceState: index ? 'not_evaluated' : 'pass',
    revision: 1, originRootTurnId: 'root-' + id, deadlineAt: '2026-11-04T00:00:00Z',
  },
}));
window.fetch = async (input) => {
  const path = new URL(input instanceof Request ? input.url : input, location.href).pathname;
  if (path === '/api/sessions/session-second/channel/tasks') return Response.json(workers);
  if (path === '/api/sessions/channel-empty/channel/tasks') return Response.json([]);
  return Response.json({error: 'unexpected fixture request'}, {status: 404});
};

function Fixture() {
  const empty = params.has('empty');
  const [selected, setSelected] = useState('');
  return <main style={{margin: 12, fontFamily: 'var(--font-ui)', color: 'var(--foreground)'}}>
    <header style={{display: 'inline-flex', alignItems: 'center', gap: 12}}>
      <strong>{empty ? '新专员' : '发布专员'}</strong>
      <SpecialistTaskMenu sessionId={empty ? 'channel-empty' : 'session-second'}
        currentTaskId={empty ? undefined : 'task-second'} source={empty ? undefined : '查看本项目的发布记录'}
        onTask={worker => setSelected(worker.sessionId)} />
    </header>
    <p><output aria-label="已选择的执行会话">{selected}</output></p>
  </main>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
