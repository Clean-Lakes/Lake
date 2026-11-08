import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {SidebarPilotEntry} from '../src/SidebarPilotEntry';

test('Pilot is a built-in specialist row with its own selection and no delete menu',()=>{
 const html=renderToStaticMarkup(createElement(SidebarPilotEntry,{selected:true,onPilot(){}}));
 assert.match(html,/aria-label="Pilot · 话事人 · 内置专员 · 对话与任务统筹"/);
 assert.match(html,/aria-current="page"/);
 assert.doesNotMatch(html,/brand\/lake-app-icon\.png/);
 const visible=html.replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim();
 assert.match(visible,/^Pilot 话事人 对话与任务统筹$/);
 assert.match(html,/title="Pilot · 话事人 · 内置专员 · 对话与任务统筹 · 不可删除"/);
 assert.equal((html.match(/<button/g)??[]).length,1);
 assert.match(html,/data-role="coordinator"/);
 assert.doesNotMatch(html,/aria-haspopup|删除专员|sidebar-pilot-slash/);
 assert.doesNotMatch(renderToStaticMarkup(createElement(SidebarPilotEntry,{selected:false,disabled:true,onPilot(){}})),/aria-current=/);
});

test('the built-in row preserves unread metadata while running and waiting take visual priority',()=>{
 const state={cursor:'00000000000000000002',seenCursor:'00000000000000000001'};
 const render=(activity:'idle'|'running'|'waiting',seenCursor=state.seenCursor)=>renderToStaticMarkup(createElement(SidebarPilotEntry,{selected:false,activity,messageRead:{...state,seenCursor},onPilot(){}}));
 assert.match(render('idle'),/pilot-worker-unread/);
 assert.match(render('running'),/aria-label="Pilot · 话事人 · 内置专员 · 对话与任务统筹 · 处理中"/);
 assert.match(render('waiting'),/aria-label="Pilot · 话事人 · 内置专员 · 对话与任务统筹 · 待确认"/);
 assert.doesNotMatch(render('running'),/pilot-worker-unread/);
 assert.doesNotMatch(render('waiting'),/pilot-worker-unread/);
 assert.doesNotMatch(render('idle',state.cursor),/pilot-worker-unread/);
 assert.deepEqual(state,{cursor:'00000000000000000002',seenCursor:'00000000000000000001'});
});
