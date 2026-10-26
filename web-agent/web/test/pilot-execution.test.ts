import assert from 'node:assert/strict';
import test from 'node:test';
import type {Resource,SREOperation,TerminalEntry,TerminalHistory} from '../../shared/contracts';
import {pilotCommandScope,pilotExecutionGroups,pilotOperationCard} from '../src/pilotExecutionModel';
import {miniEntries,type MiniBoxScope,hasMultipleMiniResources} from '../src/miniBoxModel';
import {islandFixture} from './fixtures/pilot-island-data';
const at='2026-10-26T00:01:00Z';
const resources=[{id:'a',name:'Host A',kind:'ssh'},{id:'b',name:'Host B',kind:'local'}] as Resource[];
const op=(id:string,resourceId='a',status='dispatched',dispatchedAt=at):SREOperation=>({id,resourceId,status,risk:'readonly',dispatchedAt,preparedAt:at,call:{id,name:'shell',arguments:'{"command":"hostname"}'}} as SREOperation);
const entry=(id='entry',startedAt=at):TerminalEntry=>({id,terminalId:'terminal',generation:'g',originSessionId:'island-session',actor:'agent',command:'hostname',output:'owned-output',status:'running',startedAt,createdAt:startedAt,exitCode:null,finishedAt:null,cwd:null});
function setup(){const snapshot=islandFixture(),task=snapshot.sre!.tasks[0]!,attempt=task.attempts.find(a=>a.stepId==='logs')!,peer=task.attempts.find(a=>a.stepId==='verify-logs')!;return{snapshot,task,attempt,peer};}
function scopeFor(task:ReturnType<typeof setup>['task'],attempt:ReturnType<typeof setup>['attempt']):MiniBoxScope{return{session:task.sessionId,startedAt:at,terminals:[],live:true,connected:true,commandScope:pilotCommandScope(task,attempt)}};
const history=(entries:TerminalEntry[]):TerminalHistory=>({terminal:{id:'terminal',resourceId:'a',generation:'g'},entries,output:'manual-screen'} as TerminalHistory);

test('Pilot reuses exact resource grouping even when commands revisit an earlier host',()=>{
 const {attempt}=setup();attempt.operations=[op('a1'),op('b1','b'),op('a2')];
 const groups=pilotExecutionGroups(attempt,resources);
 assert.deepEqual(groups.map(g=>[g.resource?.id,g.entries.map(e=>e.id)]),[['a',['pilot-operation-a1','pilot-operation-a2']],['b',['pilot-operation-b1']]]);
 assert.equal(hasMultipleMiniResources(groups),true);
});
test('operation projection preserves failures, unknown and undispatched actions',()=>{
 for(const [status,expected] of [['prepared','pending'],['dispatched','running'],['succeeded','completed'],['failed','failed'],['unknown','unknown'],['not_executed','not_executed'],['cancelled','cancelled']])assert.equal(pilotOperationCard(op('op','a',status),resources).status,expected);
 const unknown=pilotExecutionGroups({...setup().attempt,operations:[op('foreign','foreign')]},resources);
 assert.notEqual(unknown[0]?.resource?.id,'a');
});
test('parallel specialists cannot display each other’s identical commands',()=>{
 const {task,attempt,peer}=setup();attempt.operations=[op('mine')];peer.operations=[op('peer','a','dispatched','2026-10-26T00:01:00.500Z')];
 const entries=[entry('mine-entry','2026-10-26T00:01:00.100Z'),entry('peer-entry','2026-10-26T00:01:00.600Z')];
 assert.deepEqual(miniEntries(history(entries),scopeFor(task,attempt),'a').map(e=>e.id),['mine-entry']);
 assert.deepEqual(miniEntries(history(entries),scopeFor(task,peer),'a').map(e=>e.id),['peer-entry']);
});
test('exact execution handles resolve dispatch ties; ambiguous histories remain hidden',()=>{
 const {task,attempt,peer}=setup();attempt.operations=[op('mine')];peer.operations=[op('peer')];
 assert.deepEqual(miniEntries(history([entry()]),scopeFor(task,attempt),'a'),[]);
 attempt.operations[0]!.result=JSON.stringify({terminal_id:'terminal',entry_id:'entry'});
 assert.equal(miniEntries(history([entry()]),scopeFor(task,attempt),'a').length,1);
 assert.equal(miniEntries(history([entry()]),scopeFor(task,peer),'a').length,0);
});
test('scoped histories reject unrelated commands, stale generations, sessions and dispatch windows',()=>{
 const {task,attempt}=setup();attempt.operations=[op('mine')];const scoped=scopeFor(task,attempt);
 for(const patch of [{command:'pwd'},{originSessionId:'peer-session'},{generation:'old'},{actor:'user' as const},{terminalId:'other'},{startedAt:'2026-10-26T00:01:04Z'}])assert.deepEqual(miniEntries(history([{...entry(),...patch}]),scoped,'a'),[]);
 assert.deepEqual(miniEntries(history([entry()]),scoped,'b'),[]);
 assert.deepEqual(miniEntries(history([entry()]),{...scoped,endedAt:at},'a'),[]);
});
test('new attempts cannot reuse an old attempt’s live terminal handle',()=>{
 const {task,attempt,peer}=setup();attempt.operations=[op('old')];peer.operations=[op('later','a','dispatched','2026-10-26T00:01:00.700Z')];
 const h=history([entry('new-entry','2026-10-26T00:01:00.800Z')]);
 assert.equal(miniEntries(h,scopeFor(task,attempt),'a').length,0);
 assert.equal(miniEntries(h,scopeFor(task,peer),'a').length,1);
});
