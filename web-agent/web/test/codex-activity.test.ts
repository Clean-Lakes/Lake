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
test('live and saved transcripts start with collapsed call groups in message order',()=>{
 const items:CodexActivityItem[]=[{id:'1',kind:'text',text:'检查服务'},{id:'2',kind:'read',text:'inspector.yaml',status:'completed',at},
   {id:'3',kind:'text',text:'核对日志'},{id:'4',kind:'task',text:'核对巡检日志',status:'completed',at},
   {id:'5',kind:'command',text:'journalctl -u inspector -n 20',status:'running',at,output:'scan started'}];
 const html=renderToStaticMarkup(createElement(CodexActivity,{items,live:true}));
 assert.match(html,/检查服务.*已读取 1 个文件.*核对日志.*核对巡检日志.*正在运行 1 条命令/s);
 assert.doesNotMatch(html,/inspector\.yaml|journalctl|scan started|<li/);
 assert.equal(html.match(/aria-expanded="false"/g)?.length,2);
 assert.match(html,/<div class="codex-task-event">.*?<span class="codex-task-chip">核对巡检日志<\/span>/);
 assert.equal(html.match(/class="codex-tool-group"/g)?.length,2);
 const finished=updateCodexActivity(items,{...items[4]!,kind:'command',at,status:'completed',output:'done'});
 assert.equal(finished.length,5);
 const saved=renderToStaticMarkup(createElement(CodexActivity,{items:finished,reportText:'核对日志'}));
 assert.equal(saved.match(/aria-expanded="false"/g)?.length,2);
 assert.equal(saved.match(/data-complete="true"/g)?.length,2);
 assert.match(saved,/已运行 1 条命令/);
 assert.doesNotMatch(saved,/>核对日志<|journalctl|>done</);
});
test('the group ring counts successful calls and stays incomplete after a failure, stop or unknown result',()=>{
 const command={id:'one',kind:'command',at,status:'completed',text:'pwd'} as const;
 for(const status of ['running','failed','unknown','stopped','completed'] as const){
  const items=[command,{...command,id:'two',status}];
  const html=renderToStaticMarkup(createElement(CodexActivity,{items,live:true}));
  assert.equal(html.match(/class="codex-tool-group"/g)?.length,1);
  const complete=status==='completed';
  assert.ok(html.includes(`data-complete="${complete}"`));
  assert.ok(html.includes(`stroke-dasharray="${complete?100:50} 100"`));
  assert.doesNotMatch(html,/data-kind="command"/);
 }
});
test('the active cursor stays on the latest paragraph when tool timers are paused',()=>{
 const items:CodexActivityItem[]=[{id:'opening',kind:'text',text:'先整理材料'},{id:'current',kind:'text',text:'继续核对'},
   {id:'tool',kind:'integration',text:'查阅记录',status:'running',at}];
 const html=renderToStaticMarkup(createElement(CodexActivity,{items,cursorAvatar:'kingfisher'}));
 assert.equal(html.match(/class="specialist-reply-cursor"/g)?.length,1);
 assert.match(html,/继续核<span class="specialist-reply-cursor-tail">对<span class="specialist-reply-cursor" data-cursor-avatar="kingfisher"/);
 assert.doesNotMatch(renderToStaticMarkup(createElement(CodexActivity,{items})),/class="specialist-reply-cursor"/);
});
test('a newly streamed Codex paragraph starts immediately while existing prose reads in full',()=>{
 const items:CodexActivityItem[]=[{id:'earlier',kind:'text',text:'这一段已完整呈现。'},
   {id:'current',kind:'text',text:'新段继续核对。'}];
 const live=renderToStaticMarkup(createElement(CodexActivity,{items,live:true,animateInitial:true}));
 assert.match(live,/<p>这一段已完整呈现。<\/p>/);
 assert.match(live,/<p>新<\/p>/);
 assert.match(renderToStaticMarkup(createElement(CodexActivity,{items,live:true})),/<p>新段继续核对。<\/p>/);
});
