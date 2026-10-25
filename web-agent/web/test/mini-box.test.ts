import assert from 'node:assert/strict';
import test from 'node:test';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import type {TerminalEntry,TerminalHistory} from '../../shared/contracts';
import {miniCanStop,miniControlActive,miniEntries,miniTarget,type MiniBoxScope} from '../src/miniBoxModel';
import {MiniBoxCompletionNotice} from '../src/MiniBox';
import {ThinkingTimeline} from '../src/ThinkingTimeline';
import {ExecutionDetailsOpen} from '../src/TurnExecutionDetails';
import {miniReadableOutput,miniPreview,miniPreviewRows} from '../src/miniBoxPreview';

const at='2026-10-24T10:00:00Z';
const scope:MiniBoxScope={session:'s',terminals:[],startedAt:at,live:true,connected:true};
const entry=(overrides:Partial<TerminalEntry>={}):TerminalEntry=>({id:'e',terminalId:'t',generation:'g',actor:'agent',originSessionId:'s',command:'hostname',output:'hos',status:'running',startedAt:at,createdAt:at,finishedAt:null,cwd:null,exitCode:null,...overrides});
const history=(entries=[entry()]):TerminalHistory=>({terminal:{id:'t',resourceId:'r',generation:'g',status:'busy',holder:'agent',writerSessionId:'s'},entries,output:'private-manual-output'} as TerminalHistory);

test('local and SSH command records use the same mini terminal while other resource tools retain their view',()=>{
 const render=(kind:'local'|'ssh'|'kubernetes',title='shell')=>renderToStaticMarkup(createElement(ExecutionDetailsOpen.Provider,{value:true},createElement(ThinkingTimeline,{live:true,resource:{id:'r',name:'fixture',kind},miniScope:scope,cards:[{id:'command',type:'operation',title,status:'completed',at,data:{arguments:{command:'printf mini-output'}},content:'mini-output'}]})));
 assert.ok(render('local').includes('Mini Box 本机 命令终端'));
 assert.ok(render('ssh').includes('Mini Box SSH 命令终端'));
 assert.ok(!render('kubernetes').includes('Mini Box'));
 assert.ok(render('local','inspect_host').includes('Mini Box 本机 命令终端'));
 assert.ok(!render('local','read').includes('Mini Box'));
});

test('mini SSH data stays within the exact session, resource, turn and terminal generation',()=>{
 const good=entry();const h=history([good,entry({originSessionId:'foreign'}),entry({actor:'user'}),entry({generation:'old'}),entry({startedAt:'2026-10-23T00:00:00Z'})]);
 assert.deepEqual(miniEntries(h,scope,'r'),[good]);
 assert.deepEqual(miniEntries(h,scope,'other-resource'),[]);
 assert.deepEqual(miniEntries(h,{...scope,endedAt:at},'r'),[]);
});
test('each resource mini targets its actual running command and disables stale or stopped requests',()=>{
 const target=miniTarget([history()]);assert.equal(miniCanStop(target,scope,false),true);
 assert.equal(miniCanStop(target,{...scope,live:false},false),false);
 assert.equal(miniCanStop(target,scope,true),false);
 assert.equal(miniCanStop(miniTarget([history([entry({stopRequestedAt:at})])]),scope,false),false);
 assert.equal(miniCanStop(miniTarget([{...history(),terminal:{...history().terminal,writerSessionId:'foreign'}}]),scope,false),false);
 assert.equal(miniTarget([history([entry({status:'completed'}),entry({id:'live',status:'running'})])])?.entry.id,'live');
});
test('compact preview retains every raw command line and excludes manual screen history',()=>{
 const h=history([entry({output:'first\r\nsecond\r\nthird\r\nfourth\r\n'})]);
 const command=miniEntries(h,scope,'r')[0]!;
 const raw=miniReadableOutput(command.output),preview=miniPreview(command.output);
 assert.equal(raw,'first\nsecond\nthird\nfourth\n');
 assert.deepEqual(miniPreviewRows(preview,undefined).map(row=>row.text),['second','third','fourth']);
 assert.ok(!raw.includes(h.output));
});
test('turn-end notice names only resources with a user stop in that turn',()=>{
 const html=renderToStaticMarkup(createElement(MiniBoxCompletionNotice,{startedAt:at,notices:[{entryId:'e',terminalId:'t',resourceId:'r',resourceName:'SSH A',requestedAt:at,status:'unknown',exitCode:null,finishedAt:at},{entryId:'old',terminalId:'old',resourceId:'old',resourceName:'Old resource',requestedAt:'2026-10-23T00:00:00Z',status:'unknown',exitCode:null,finishedAt:null}]}));
 assert.ok(html.includes('SSH A'));assert.ok(!html.includes('Old resource'));assert.ok(html.includes('需核查'));
});

test('AI control spans the short command gaps inside a running host inspection',()=>{
 const card={id:'inspection',type:'operation',title:'inspect_host',status:'running',at};
 const completed=miniTarget([history([entry({status:'completed',exitCode:0})])]);
 assert.equal(miniControlActive(scope,card,completed,false,false),true);
 assert.equal(miniControlActive(scope,{...card,status:'completed'},completed,false,false),false);
 assert.equal(miniControlActive(scope,card,miniTarget([history()]),false,false),true);
 for(const options of [{...scope,live:false},{...scope,connected:false},{...scope,waiting:true}])assert.equal(miniControlActive(options,card,completed,false,false),false);
 assert.equal(miniControlActive(scope,card,completed,true,false),false);
 assert.equal(miniControlActive(scope,card,completed,false,true),false);
 assert.equal(miniControlActive(scope,card,miniTarget([history([entry({status:'unknown'})])]),false,false),false);
 assert.equal(miniControlActive(scope,card,miniTarget([history([entry({stopRequestedAt:at})])]),false,false),false);
});
