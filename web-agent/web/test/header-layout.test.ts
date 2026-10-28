import assert from 'node:assert/strict';
import test from 'node:test';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {PilotHeaderState} from '../src/PilotHeaderState';
import {pilotIslandModel} from '../src/pilotIslandModel';
import {islandFixture,type IslandFixtureState} from './fixtures/pilot-island-data';

function render(open:boolean,state:IslandFixtureState='parallel',terminalOpen=false){
 const model=pilotIslandModel(islandFixture(state))!;
 return renderToStaticMarkup(createElement(PilotHeaderState,{
  model,status:'investigating',normal:createElement('span',null,'调查中'),onInspect(){},
  details:{available:true,open,toggle(){}},
  terminal:{open:terminalOpen,label:'演示主机',kind:'ssh',connected:true,toggle(){}},
 }));
}

test('opening the inspector replaces specialist detail with a concise status and preserves its controls',()=>{
 const expanded=render(true),collapsed=render(false);
 assert.match(expanded,/header-normal-state is-visible/);
 assert.match(expanded,/header-pilot-state" aria-hidden="true" inert=""/);
 assert.match(expanded,/pilot-island-trigger[^>]*disabled=""/);
 assert.match(expanded,/收起计划与执行/);
 assert.match(collapsed,/header-pilot-state is-visible/);
 assert.match(collapsed,/header-normal-state" aria-hidden="true" inert=""/);
 assert.match(collapsed,/展开计划与执行/);
 assert.equal((expanded.match(/class="header-inspector-toggle"/g)??[]).length,1);
});

test('compact status preserves requests for intervention and an inconclusive result',()=>{
 for(const state of ['choice','unknown','failed','finished','stopping'] as const){
  const html=render(true,state),model=pilotIslandModel(islandFixture(state))!;
  const visible=html.split('header-normal-state is-visible')[1]!.split('header-pilot-state')[0]!;
  assert.ok(visible.includes(model.label),state);
  if(model.tone==='attention')assert.match(visible,/state-waiting_approval/);
  if(model.tone==='failed')assert.match(visible,/state-failed/);
  if(state==='finished')assert.match(visible,/结论不充分/);
 }
});

test('a visible terminal owns its resource label and the header keeps an accessible collapse control',()=>{
 const closed=render(true),open=render(true,'parallel',true);
 assert.match(closed,/header-terminal-label">演示主机/);
 assert.match(closed,/aria-label="展开资源终端：演示主机"/);
 assert.ok(!open.includes('header-terminal-label'));
 assert.match(open,/aria-label="收起资源终端"/);
 assert.match(open,/aria-controls="resource-terminal-panel" aria-expanded="true"/);
});
