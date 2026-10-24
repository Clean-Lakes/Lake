import assert from 'node:assert/strict';
import test from 'node:test';
import {reconcileQueuePresence,type QueuePresence} from '../src/queuePresence';
import type {QueuedMessage} from '../../shared/contracts';
const item=(id:string,text=id):QueuedMessage=>({id,text,resourceIds:[],images:[],files:[],createdAt:'2026-10-25T00:00:00Z'});
const present=(id:string):QueuePresence=>({item:item(id),phase:'present'});

test('queue refresh and edits preserve presence while new IDs enter only once',()=>{
 const added=reconcileQueuePresence([present('a')],[item('a','edited'),item('b')],true);
 assert.deepEqual(added.map(row=>[row.item.id,row.phase]),[['a','present'],['b','entering']]);
 const refreshed=reconcileQueuePresence(added,[item('a','latest'),item('b')],true);
 assert.equal(refreshed[0]!.item.text,'latest');
 assert.deepEqual(refreshed.map(row=>row.phase),['present','entering']);
});
test('consumed rows retire in place without entering the live queue or losing siblings',()=>{
 const next=reconcileQueuePresence([present('a'),present('b'),present('c')],[item('c'),item('b')],true);
 assert.deepEqual(next.map(row=>[row.item.id,row.phase]),[['a','leaving'],['c','present'],['b','present']]);
 const last=reconcileQueuePresence(next,[],true);
 assert.equal(last.length,3);
 assert.ok(last.every(row=>row.phase==='leaving'));
});
test('rapid reversal preserves one identity and static restoration drops retiring rows',()=>{
 const leaving=reconcileQueuePresence([present('a')],[],true);
 const restored=reconcileQueuePresence(leaving,[item('a','returned')],true);
 assert.deepEqual(restored.map(row=>[row.item.id,row.phase]),[['a','entering']]);
 assert.deepEqual(reconcileQueuePresence(restored,[],false),[]);
 assert.deepEqual(reconcileQueuePresence(leaving,[item('b')],false).map(row=>[row.item.id,row.phase]),[['b','present']]);
});
