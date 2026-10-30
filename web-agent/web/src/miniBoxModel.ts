import type {AICard, TerminalHistory, TerminalSession, TerminalEntry} from '../../shared/contracts';

export type MiniCommandScope = {owned:string[];calls:Array<{id:string;resource:string;command:string;startedAt:string;terminalId?:string;entryId?:string}>};

export type MiniBoxScope = {session:string;terminals:TerminalSession[];startedAt:string;endedAt?:string;live:boolean;waiting?:boolean;connected:boolean;multiResource?:boolean;commandScope?:MiniCommandScope};
// Host inspection also executes real command blocks through the same terminal.
export const isTerminalCommand = (card:AICard) => ['shell','terminal_execute_command','inspect_host'].includes(card.title ?? '');

export function miniEntries(history:TerminalHistory,scope:MiniBoxScope,resource:string) {
  if(history.terminal.resourceId!==resource || !history.terminal.generation)return [];
  const start=Date.parse(scope.startedAt),end=scope.endedAt?Date.parse(scope.endedAt):Infinity;
  if(!Number.isFinite(start))return [];
  return history.entries.filter(entry=>entry.actor==='agent'&&entry.originSessionId===scope.session
    &&entry.terminalId===history.terminal.id&&entry.generation===history.terminal.generation
    &&Date.parse(entry.startedAt??entry.createdAt)>=start&&Date.parse(entry.startedAt??entry.createdAt)<end&&miniEntryOwned(entry,scope,resource));
}

// A Pilot role shares its parent session with peers. Exact recorded handles win;
// otherwise only the uniquely latest matching dispatch can own the entry.
function miniEntryOwned(entry:TerminalEntry,scope:MiniBoxScope,resource:string){
  if(!scope.commandScope)return true;
  const time=Date.parse(entry.startedAt??entry.createdAt);
  const matches=scope.commandScope.calls.filter(call=>call.resource===resource&&call.command===entry.command
    &&(!call.terminalId||call.terminalId===entry.terminalId)
    &&(call.entryId?call.entryId===entry.id:time>=Date.parse(call.startedAt)&&time-Date.parse(call.startedAt)<=2000));
  const exact=matches.filter(call=>!!call.entryId);
  const latest=Math.max(...matches.map(call=>Date.parse(call.startedAt)));
  const owners=exact.length?exact:matches.filter(call=>Date.parse(call.startedAt)===latest);
  return owners.length===1&&scope.commandScope.owned.includes(owners[0]!.id);
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

// Layout is based on every host command in this turn, including completed
// commands. A fast host must not disappear from the count before the next starts.
export function hasMultipleMiniResources(groups:Array<{resource?:{id?:string;kind?:string};entries:Array<{card?:AICard}>}>) {
  const resources=new Set<string>();
  for(const group of groups){
    const resource=group.resource;
    if(resource?.id&&['local','ssh'].includes(resource.kind??'')&&group.entries.some(entry=>entry.card&&isTerminalCommand(entry.card)))resources.add(resource.id);
  }
  return resources.size>1;
}
