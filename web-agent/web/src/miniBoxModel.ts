import type {AICard, TerminalHistory, TerminalSession} from '../../shared/contracts';

export type MiniBoxScope = {session:string;terminals:TerminalSession[];startedAt:string;endedAt?:string;live:boolean;waiting?:boolean;connected:boolean};
// Host inspection also executes real command blocks through the same terminal.
export const isTerminalCommand = (card:AICard) => ['shell','terminal_execute_command','inspect_host'].includes(card.title ?? '');

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
