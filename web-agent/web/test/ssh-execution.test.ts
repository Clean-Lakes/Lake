import assert from 'node:assert/strict';
import test from 'node:test';
import type {SessionSnapshot, TerminalEntry, TerminalHistory} from '../../shared/contracts';
import {executionEntries, executionIsActive, executionOutput, latestExecution, sshExecutionScope} from '../src/sshExecution';
import {terminalOutputUpdate} from '../src/terminalOutput';

const start = '2026-10-24T01:00:00Z';
const entry = (overrides: Partial<TerminalEntry> = {}) => ({id:'entry', terminalId:'ssh', generation:'g1', actor:'agent', originSessionId:'current', command:'printf hello', output:'hel', status:'running', startedAt:start, createdAt:start, exitCode:null, finishedAt:null, cwd:null, ...overrides} as TerminalEntry);
const history = (entries = [entry()]) => ({terminal:{id:'ssh', resourceId:'host', generation:'g1', status:'busy', holder:'agent'}, entries, output:'unrelated manual output'} as TerminalHistory);

test('only explicit SSH resources and current snapshot terminals become candidates', () => {
  const snapshot = {session:{id:'current'}, resources:[{id:'host',kind:'ssh'},{id:'local',kind:'local'}], terminals:[{id:'ssh',resourceId:'host'},{id:'local',resourceId:'local'},{id:'removed',resourceId:'removed'}], ai:{turnStartedAt:start,status:'running'}} as SessionSnapshot;
  assert.deepEqual(sshExecutionScope(snapshot)?.terminals.map(terminal => terminal.id), ['ssh']);
  assert.equal(sshExecutionScope({...snapshot,ai:{...snapshot.ai!,turnStartedAt:'invalid'}}),null);
  assert.equal(sshExecutionScope({...snapshot,messages:[{role:'user',createdAt:'2026-10-24T02:00:00Z'}] as SessionSnapshot['messages']}),null);
  assert.equal(sshExecutionScope(null),null);
});

test('observer excludes other sessions, previous turns, user input and replaced generations', () => {
  const own = entry();
  const entries = [own, entry({id:'other',originSessionId:'other'}),entry({id:'old',startedAt:'2026-10-23T01:00:00Z'}),entry({id:'user',actor:'user'}),entry({id:'replaced',generation:'g0'}),entry({id:'foreign-terminal',terminalId:'elsewhere'})];
  assert.deepEqual(executionEntries(history(entries),'current',start),[own]);
  assert.deepEqual(executionEntries(history(entries),'next-session',start),[]);
});

test('latest command follows real timestamps across terminals rather than grouped resource order', () => {
  const first = history([entry({id:'first'})]);
  const second = history([entry({id:'second',startedAt:'2026-10-24T01:00:02Z'})]);
  assert.equal(latestExecution([second,first]),second);
  assert.equal(latestExecution([]),undefined);
});

test('running output chunks and sequential commands append without xterm resets', () => {
  const first = entry();
  const before = executionOutput([first]);
  const streamed = executionOutput([{...first,output:'hello\r\n'}]);
  assert.deepEqual(terminalOutputUpdate(before,streamed),{text:'lo\r\n',reset:false});
  const next = executionOutput([{...first,output:'hello\r\n',status:'completed',exitCode:0},entry({id:'next',command:'uptime',output:''})]);
  assert.equal(terminalOutputUpdate(streamed,next).reset,false);
  assert.ok(!next.includes('unrelated manual output'));
  assert.equal(executionOutput([entry({command:'printf 中文',output:'中文🙂\r\n'})]),'$ printf 中文\r\n中文🙂\r\n');
});

test('blue control effect stops for confirmation, disconnect, finish, unknown and released input', () => {
  const current = history();
  assert.equal(executionIsActive(current,'running',true),true);
  for (const status of ['waiting_approval','completed','failed','cancelled','interrupted']) assert.equal(executionIsActive(current,status,true),false);
  assert.equal(executionIsActive(current,'running',false),false);
  assert.equal(executionIsActive(history([entry({status:'unknown'})]),'running',true),false);
  assert.equal(executionIsActive({...current,terminal:{...current.terminal,holder:'user'}},'running',true),false);
  assert.equal(executionIsActive({...current,terminal:{...current.terminal,status:'disconnected'}},'running',true),false);
});
