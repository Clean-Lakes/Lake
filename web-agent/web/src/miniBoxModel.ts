import type {AICard, TerminalEntry, TerminalHistory, TerminalSession} from '../../shared/contracts';

export type MiniBoxScope = {session:string;terminals:TerminalSession[];startedAt:string;endedAt?:string;live:boolean;waiting?:boolean;connected:boolean};
export const isSSHCommand = (card:AICard) => ['shell','terminal_execute_command'].includes(card.title ?? '');

export function miniEntries(history:TerminalHistory,scope:MiniBoxScope,resource:string) {
  if(history.terminal.resourceId!==resource || !history.terminal.generation)return [];
  const start=Date.parse(scope.startedAt),end=scope.endedAt?Date.parse(scope.endedAt):Infinity;
  if(!Number.isFinite(start))return [];
  return history.entries.filter(entry=>entry.actor==='agent'&&entry.originSessionId===scope.session
    &&entry.terminalId===history.terminal.id&&entry.generation===history.terminal.generation
    &&Date.parse(entry.startedAt??entry.createdAt)>=start&&Date.parse(entry.startedAt??entry.createdAt)<end);
}

export function miniTarget(histories:TerminalHistory[]) {
  const candidates=histories.flatMap(history=>history.entries.map(entry=>({history,entry})));
  const running=candidates.filter(({entry})=>entry.status==='running');
  return (running.length?running:candidates).sort((a,b)=>Date.parse(a.entry.startedAt??a.entry.createdAt)-Date.parse(b.entry.startedAt??b.entry.createdAt)).at(-1);
}

export function miniCanStop(target:ReturnType<typeof miniTarget>,scope:MiniBoxScope,stale:boolean) {
  return !!target&&scope.live&&scope.connected&&!stale&&!target.entry.stopRequestedAt
    &&target.entry.status==='running'&&target.history.terminal.status==='busy'&&target.history.terminal.holder==='agent'
    &&(!target.history.terminal.writerSessionId||target.history.terminal.writerSessionId===scope.session);
}

export function miniOutput(entries:TerminalEntry[]) {
  return entries.map(entry=>`$ ${entry.command}\r\n${entry.output}`).join('\r\n\r\n');
}

export function miniRecordedOutput(card:AICard|undefined) {
  if(!card)return '';
  const data=card.data as {arguments?:{command?:unknown}}|undefined;
  const command=typeof data?.arguments?.command==='string'?data.arguments.command:'';
  let output=card.content??'';
  try {const value=JSON.parse(output);if(typeof value.output==='string')output=value.output;}catch{/* Retain the recorded text, never infer a live terminal handle. */}
  return `${command?`$ ${command}\r\n`:''}${output}`;
}
