import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {SidebarPilotEntry} from '../src/SidebarPilotEntry';

test('the brand names the Pilot destination and exposes the current page without a duplicate navigation row',()=>{
 const html=renderToStaticMarkup(createElement(SidebarPilotEntry,{selected:true,onPilot(){}}));
 assert.match(html,/aria-label="Lake · Pilot 主对话"/);
 assert.match(html,/aria-current="page"/);
 assert.match(html,/brand\/lake-app-icon\.png/);
 assert.match(html,/>Lake<\/strong>/);
 assert.equal((html.match(/<button/g)??[]).length,1);
 assert.doesNotMatch(html,/pilot-workspace-entry|super-role-avatar/);
 assert.doesNotMatch(renderToStaticMarkup(createElement(SidebarPilotEntry,{selected:false,disabled:true,onPilot(){}})),/aria-current=/);
});

test('the single brand entry preserves unread metadata while running and waiting take visual priority',()=>{
 const state={cursor:'00000000000000000002',seenCursor:'00000000000000000001'};
 const render=(activity:'idle'|'running'|'waiting',seenCursor=state.seenCursor)=>renderToStaticMarkup(createElement(SidebarPilotEntry,{selected:false,activity,messageRead:{...state,seenCursor},onPilot(){}}));
 assert.match(render('idle'),/pilot-worker-unread/);
 assert.match(render('running'),/aria-label="Lake · Pilot 主对话 · 处理中"/);
 assert.match(render('waiting'),/aria-label="Lake · Pilot 主对话 · 待确认"/);
 assert.doesNotMatch(render('running'),/pilot-worker-unread/);
 assert.doesNotMatch(render('waiting'),/pilot-worker-unread/);
 assert.doesNotMatch(render('idle',state.cursor),/pilot-worker-unread/);
 assert.deepEqual(state,{cursor:'00000000000000000002',seenCursor:'00000000000000000001'});
});
