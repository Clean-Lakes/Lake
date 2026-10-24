import {useState} from 'react';
import type {Resource, TerminalHistory} from '../../shared/contracts';
import {Glyph} from './Icons';
import {TerminalPane} from './TerminalPane';
import {executionIsActive, executionOutput, latestExecution} from './sshExecution';
import './sshExecution.css';

const observeOnly = () => {};

export function SSHExecutionGlow({active}: {active: boolean}) {
  return active ? <div className="ssh-execution-glow" aria-hidden="true"><span/><span/></div> : null;
}

export function SSHExecutionPanel({histories, resources, status, stale, onClose}: {
  histories: TerminalHistory[]; resources: Resource[]; status?: string; stale: boolean; onClose: () => void;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const history = histories.find(item => item.terminal.id === selected) ?? latestExecution(histories);
  if (!history) return null;
  const active = executionIsActive(history, status, !stale);
  const entry = history.entries.at(-1);
  const label = stale ? '实时输出暂时断开' : status === 'waiting_approval' ? '等待确认'
    : active ? 'Lake 正在操作' : entry?.status === 'unknown' ? '结果待核查'
    : entry?.status === 'running' ? '命令仍在运行' : entry?.exitCode !== null && entry?.exitCode !== 0 ? '命令执行失败' : '命令已结束';
  return <section className={`terminal-panel-content ssh-execution-panel${active ? ' is-operating' : ''}`} aria-label="Lake SSH 执行终端">
    <header className="terminal-panel-header">
      <Glyph name="terminal" size={17}/><strong>SSH 执行终端</strong>
      <button type="button" className="icon-button" aria-label="收起执行终端" title="收起终端，任务继续执行" onClick={onClose}><Glyph name="close" size={17}/></button>
    </header>
    <div className="ssh-execution-status" role="status"><Glyph name={active ? 'spark' : stale ? 'alert' : 'terminal'} size={15}/><span>{label}</span><small>只读</small></div>
    <div className="ssh-execution-tabs" role="tablist" aria-label="执行中的 SSH 终端" onKeyDown={event => {
      if (!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
      const tabs = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
      const index = tabs.indexOf(event.target as HTMLButtonElement);
      if (index < 0) return;
      event.preventDefault();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
      tabs[next]?.focus(); tabs[next]?.click();
    }}>{histories.map(item => {
      const resource = resources.find(resource => resource.id === item.terminal.resourceId);
      return <button type="button" role="tab" tabIndex={item.terminal.id === history.terminal.id ? 0 : -1} aria-selected={item.terminal.id === history.terminal.id} aria-controls={`ssh-execution-${item.terminal.id}`} id={`ssh-tab-${item.terminal.id}`} key={item.terminal.id} onClick={() => setSelected(item.terminal.id)}><Glyph name="server" size={14}/><span>{resource?.name ?? 'SSH 终端'}</span>{histories.filter(other => other.terminal.resourceId === item.terminal.resourceId).length > 1 && <small>{item.terminal.id.slice(0, 6)}</small>}</button>;
    })}</div>
    <div className="drawer-body"><div className="terminal-session">{histories.map(item => <div key={`${item.terminal.id}:${item.terminal.generation}`} className="terminal-screen-slot" role="tabpanel" id={`ssh-execution-${item.terminal.id}`} aria-labelledby={`ssh-tab-${item.terminal.id}`} hidden={item.terminal.id !== history.terminal.id}>
      <TerminalPane active={item.terminal.id === history.terminal.id} entries={item.entries} output={executionOutput(item.entries)} interactive={false} onInput={observeOnly} onResize={observeOnly}/>
    </div>)}</div></div>
    <p className="ssh-execution-note">{stale ? '已保留收到的输出，连接恢复后继续更新。' : '实时显示本轮命令与输出 · 向上滚动可暂停跟随'}</p>
  </section>;
}
