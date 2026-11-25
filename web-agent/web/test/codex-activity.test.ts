import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import type {SessionEvent,SessionSnapshot} from '../../shared/contracts';
import {applyLiveText} from '../src/liveTextUpdates';
import {CodexActivity} from '../src/CodexActivity';
import {updateCodexActivity,type CodexActivityItem} from '../../shared/codex-activity';
const at='2026-11-25T01:00:00Z';
test('SSE updates the matching root call in place and rejects a different task',()=>{
 const data={source:'external_agent',external_run_id:'run',external_agent:'codex',taskId:'task',root_turn_id:'root'};
 const snapshot={cursor:1,session:{id:'worker'},ai:{rootTurnId:'root',status:'running',cards:[{id:'run',type:'operation',status:'running',at,data}]}} as unknown as SessionSnapshot;
 const item:CodexActivityItem={kind:'command',id:'call',text:'example',status:'running',at};
 const update={target:'card',id:'run',rootTurnId:'root',cardType:'operation',content:'',codexTaskId:'task',codexItem:item} as const;
 const event={sessionId:'worker',type:'session',seq:2,textUpdate:update} as SessionEvent;
 const first=applyLiveText(snapshot,event)!;
 assert.equal((first.ai!.cards[0]!.data as any).codex_activity[0].text,'example');
 const second=applyLiveText(first,{...event,seq:3,textUpdate:{...update,codexItem:{...item,output:'hello'}}})!;
 assert.equal((second.ai!.cards[0]!.data as any).codex_activity.length,1);
 assert.equal((second.ai!.cards[0]!.data as any).codex_activity[0].output,'hello');
 assert.equal(applyLiveText(snapshot,{...event,textUpdate:{...update,codexTaskId:'other'}}),null);
});
test('running and finished work both show their actual text and output without interaction',()=>{
 const items:CodexActivityItem[]=[{id:'1',kind:'text',text:'检查服务'},{id:'2',kind:'read',text:'inspector.yaml',status:'completed',at},
   {id:'3',kind:'text',text:'核对日志'},{id:'4',kind:'task',text:'核对巡检日志',status:'completed',at},
   {id:'5',kind:'command',text:'journalctl -u inspector -n 20',status:'running',at,output:'scan started'}];
 const html=renderToStaticMarkup(createElement(CodexActivity,{items,live:true}));
 for(const part of ['inspector.yaml','journalctl -u inspector -n 20','进行中','scan started','核对巡检日志'])assert.ok(html.includes(part),part);
 assert.ok(html.indexOf('检查服务')<html.indexOf('inspector.yaml')&&html.indexOf('inspector.yaml')<html.indexOf('核对日志'));
 const finished=updateCodexActivity(items,{...items[4]!,kind:'command',at,status:'completed',output:'done'});
 assert.equal(finished.length,5);
 const saved=renderToStaticMarkup(createElement(CodexActivity,{items:finished,reportText:'核对日志'}));
 assert.ok(!saved.includes('aria-expanded')&&!saved.includes('>核对日志<')&&saved.includes('journalctl -u inspector -n 20')&&saved.includes('done'));
});
test('all consecutive commands remain individually readable, including repeated commands and multiline scripts',()=>{
 const items:CodexActivityItem[]=['pwd','pwd','date\necho ok','whoami','ls'].map((text,i)=>({id:String(i),kind:'command',status:'completed',at,text}));
 const html=renderToStaticMarkup(createElement(CodexActivity,{items}));
 assert.equal(html.match(/data-kind="command"/g)?.length,5);
 assert.equal(html.match(/>pwd</g)?.length,2);
 assert.match(html,/date\necho ok/);
 assert.doesNotMatch(html,/aria-expanded|<button|内容已隐藏/);
});
