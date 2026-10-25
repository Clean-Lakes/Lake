import type {AICard, TerminalHistory, TerminalSession} from '../../shared/contracts';

export type MiniBoxScope = {session:string;terminals:TerminalSession[];startedAt:string;endedAt?:string;live:boolean;waiting?:boolean;connected:boolean;parallel?:boolean};
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

// inspect_host owns a sequence of command entries. A completed sample does not
// release AI control while its parent operation is still running.
export function miniControlActive(scope:MiniBoxScope,card:AICard|undefined,target:ReturnType<typeof miniTarget>,stale:boolean,stopping:boolean) {
  if(!scope.live||!scope.connected||scope.waiting||stale||stopping||target?.entry.stopRequestedAt)return false;
  if(target?.entry.status==='unknown'||target?.history.terminal.status==='disconnected'||target?.history.terminal.status==='unknown')return false;
  return card?.status==='running'||target?.entry.status==='running';
}

export function hasParallelMiniResources(groups:Array<{resource?:{id?:string;kind?:string};entries:Array<{card?:AICard}>}>,terminals:TerminalSession[],session:string) {
  const active=new Set<string>();
  for(const group of groups){
    const resource=group.resource;
    if(!resource?.id||!['local','ssh'].includes(resource.kind??''))continue;
    const commands=group.entries.flatMap(entry=>entry.card&&isTerminalCommand(entry.card)?[entry.card]:[]);
    if(!commands.length)continue;
    const busy=terminals.some(terminal=>terminal.resourceId===resource.id&&!!terminal.generation&&terminal.status==='busy'&&terminal.holder==='agent'&&(terminal.writerSessionId??terminal.sessionId)===session);
    if(busy||commands.some(card=>['running','background_running'].includes(card.status)))active.add(resource.id);
  }
  return active.size>1;
}
