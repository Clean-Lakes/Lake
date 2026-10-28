import assert from 'node:assert/strict';
import test from 'node:test';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {PilotHeaderState} from '../src/PilotHeaderState';
import {TerminalSidePanel} from '../src/TerminalSidePanel';
import {pilotIslandModel} from '../src/pilotIslandModel';
import {islandFixture,type IslandFixtureState} from './fixtures/pilot-island-data';

function render(open:boolean,state:IslandFixtureState='running'){
 return renderToStaticMarkup(createElement(PilotHeaderState,{
  model:pilotIslandModel(islandFixture(state)),status:'investigating',normal:createElement('span',null,'调查中'),onInspect(){},
  details:{available:true,open,toggle(){}},
 }));
}

// The shared summary from #108 was replaced by independent pane islands in
// #109. Opening the inspector must no longer hide Pilot's specialist entry.
test('opening an independent inspector preserves the Pilot specialist entry',()=>{
 for(const open of [false,true]){
  const html=render(open);
  assert.match(html,/header-pilot-state is-visible"[^>]*aria-hidden="false"/);
  assert.match(html,/header-normal-state"[^>]*aria-hidden="true"[^>]*inert/);
  assert.doesNotMatch(html,/pilot-island-trigger[^>]*disabled=""/);
  assert.equal((html.match(/class="pilot-island-trigger"/g)??[]).length,1);
 }
});

test('independent Pilot entry preserves intervention and inconclusive state descriptions',()=>{
 for(const state of ['choice','unknown','failed','finished','stopping'] as const){
  const html=render(true,state),model=pilotIslandModel(islandFixture(state))!;
  assert.ok(html.includes(`Lake Pilot：${model.detail}`),state);
  assert.match(html,/header-pilot-state is-visible/);
  if(model.tone==='attention')assert.match(html,/data-tone="attention"/);
  if(model.tone==='failed')assert.match(html,/data-tone="failed"/);
  if(state==='finished')assert.match(html,/结论不充分/);
 }
});

test('terminal panel exposes its stable target and makes collapsed screens inert',()=>{
 for(const open of [false,true]){
  const html=renderToStaticMarkup(createElement(TerminalSidePanel,{open,onClose(){},children:'终端内容'}));
  assert.match(html,/id="resource-terminal-panel"/);
  if(open){assert.match(html,/aria-label="资源终端"/);assert.doesNotMatch(html,/inert=""/);}
  else assert.match(html,/inert="" aria-hidden="true"/);
 }
});
