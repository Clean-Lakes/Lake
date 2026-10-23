import test from 'node:test';
import assert from 'node:assert/strict';
import type {WorkSession} from '../../shared/contracts';
import {sortSessionNavigation,sessionDropBefore} from '../src/sessionNavigationModel';
const item=(id:string,extra:Partial<WorkSession>={})=>({id,projectId:'project',updatedAt:'2026-10-23T09:00:00Z',...extra} as WorkSession);

test('pinned and ordinary groups preserve manual order despite newer activity',()=>{
 const sessions=[item('ordinary',{navigationPosition:0,updatedAt:'2026-10-23T12:00:00Z'}),item('second',{pinned:true,navigationPosition:1}),item('first',{pinned:true,navigationPosition:0}),item('ordinary-last',{navigationPosition:1})];
 assert.deepEqual(sortSessionNavigation(sessions).map(s=>s.id),['first','second','ordinary','ordinary-last']);
 sessions[3]!.updatedAt='2026-10-24T12:00:00Z';
 assert.deepEqual(sortSessionNavigation(sessions).map(s=>s.id),['first','second','ordinary','ordinary-last']);
});
test('new sessions appear above manually ordered ordinary sessions; initial histories remain recent-first',()=>{
 assert.deepEqual(sortSessionNavigation([item('saved',{navigationPosition:0}),item('new',{updatedAt:'2026-10-23T10:00:00Z'}),item('pin',{pinned:true,navigationPosition:0})]).map(s=>s.id),['pin','new','saved']);
 assert.deepEqual(sortSessionNavigation([item('old'),item('recent',{updatedAt:'2026-10-23T10:00:00Z'})]).map(s=>s.id),['recent','old']);
});
test('drop anchors account for source removal and hidden history',()=>{
 const sessions=['a','b','c','hidden'].map(id=>item(id));
 assert.equal(sessionDropBefore(sessions,'a','c',true),'hidden');
 assert.equal(sessionDropBefore(sessions,'c','a',false),'a');
 assert.equal(sessionDropBefore(sessions,'external','hidden',true),null);
 assert.deepEqual(sessions.map(s=>s.id),['a','b','c','hidden']);
});
