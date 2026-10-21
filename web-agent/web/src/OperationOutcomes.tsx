import {useState} from 'react';
import type {AIOperationOutcome} from '../../shared/contracts';
import {AppSelect} from './AppSelect';
import {DisclosureSummary} from './DisclosureSummary';
import {api, readableError} from './api';

export function OperationOutcomes({session, operations, running, disabled, refresh}: {session: string; operations: AIOperationOutcome[]; running: boolean; disabled: boolean; refresh?: () => Promise<unknown>}) {
  const unknown = operations.filter(operation => operation.status === 'unknown');
  if (!unknown.length) return null;
  return <details className="operation-outcomes"><DisclosureSummary>待核实操作 · {unknown.length}</DisclosureSummary>
    <p>原操作的执行结果尚不明确，可继续独立的只读检查。核实实际结果后在此记录，再决定后续变更。</p>
    {running && <p role="status">请先停止当前运行，再填写核实结果。</p>}
    {unknown.map(operation => <Outcome key={`${session}:${operation.id}`} session={session} operation={operation} disabled={disabled || running} refresh={refresh}/>)}
  </details>;
}

function Outcome({session, operation, disabled, refresh}: {session: string; operation: AIOperationOutcome; disabled: boolean; refresh?: () => Promise<unknown>}) {
  const [status, setStatus] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  async function record() {
    if (disabled || busy || !status || !note.trim() || new TextEncoder().encode(note).length > 4000) return;
    setBusy(true); setError('');
    try {
      await api.aiOperation(session, 'resolveOperation', {id: operation.id, status, note: note.trim()});
      setSaved(true);
      await refresh?.();
    } catch (error) { setError(readableError(error)); }
    finally { setBusy(false); }
  }
  return <section className="operation-outcome" aria-label={`核实 ${operation.tool} 操作`}>
    <strong>{operation.tool} · {operation.target}</strong>
    <details><DisclosureSummary>原操作记录</DisclosureSummary>
      <dl><dt>操作 ID</dt><dd>{operation.id}</dd><dt>开始时间</dt><dd>{operation.startedAt}</dd>{operation.handle && <><dt>原执行句柄</dt><dd>{operation.handle}</dd></>}</dl>
      {operation.result && <pre>{operation.result}</pre>}
    </details>
    {saved ? <p role="status">核实结果已记录；原操作不会自动重试。</p> : <fieldset disabled={disabled || busy}>
      <label className="field-label">实际核实结果<AppSelect label="实际核实结果" value={status} onChange={event => setStatus(event.target.value)}>
        <option value="">请选择核实结果</option><option value="succeeded">已执行成功</option><option value="failed">已执行失败</option><option value="not_executed">确认未执行</option>
      </AppSelect></label>
      <label className="field-label">核实依据<textarea value={note} maxLength={4000} rows={3} onChange={event => setNote(event.target.value)} placeholder="填写对原目标的检查结果、日志或执行记录；无法确认时请保留待核实状态。"/></label>
      {new TextEncoder().encode(note).length > 4000 && <p role="alert">核实依据最多 4000 字节，请缩短内容。</p>}
      <button type="button" className="button secondary" disabled={!status || !note.trim() || new TextEncoder().encode(note).length > 4000} onClick={() => void record()}>{busy ? '正在记录…' : '记录核实结果'}</button>
    </fieldset>}
    {error && <p className="form-error" role="alert">{saved ? '结果已记录，刷新失败：' : ''}{error}</p>}
  </section>;
}
