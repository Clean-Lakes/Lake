import assert from 'node:assert/strict';
import test from 'node:test';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {SessionStatusDot} from '../src/SessionStatusDot';
import {pilotIslandModel} from '../src/pilotIslandModel';
import {islandFixture,type IslandFixtureState} from './fixtures/pilot-island-data';

test('sidebar follows Pilot attention, pause, failure and finish using the same current model as the Island',()=>{
 for(const state of ['running','choice','approval','paused','failed','unknown','finished','cancelled'] satisfies IslandFixtureState[]){
  const snapshot=islandFixture(state),model=pilotIslandModel(snapshot)!;
  const html=renderToStaticMarkup(createElement(SessionStatusDot,{session:snapshot.session,snapshot}));
  assert.ok(html.includes(`data-tone="${model.tone}"`),state);
  assert.ok(html.includes('data-pilot="true"'),state);
  assert.ok(html.includes('aria-label="会话状态：Lake Pilot：'),state);
 }
});

test('a newer background catalog state discards cached Pilot activity and stays consistent with normal Island status',()=>{
 const snapshot=islandFixture('running');
 const session={...snapshot.session,status:'failed' as const,updatedAt:'2026-10-29T12:00:00Z'};
 const html=renderToStaticMarkup(createElement(SessionStatusDot,{session,snapshot}));
 assert.ok(html.includes('data-tone="attention"'));
 assert.ok(html.includes('title="需关注"'));
 assert.ok(!html.includes('data-pilot'));
 const other=renderToStaticMarkup(createElement(SessionStatusDot,{session:{...snapshot.session,id:'another',status:'completed'},snapshot}));
 assert.equal(other,'');
});
