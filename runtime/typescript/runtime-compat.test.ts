import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {LakeStore} from './store';
import {legacyNativeAgentSource,legacyNativeControlSource} from '../../web-agent/shared/runtime-compat';

test('old native child/control presentation preserves stored rows, operation IDs and task identities',async()=>{
 const home=await mkdtemp(join(tmpdir(),'lake-runtime-compat-'));
 const store=await LakeStore.open(home,join(home,'data'));
 try{
  const old={session:'session',status:'completed',cards:[{id:'control',status:'completed',data:{source:legacyNativeControlSource,taskId:'task'}}],
   agentRuns:[{id:'child',source:legacyNativeAgentSource,status:'completed',taskId:'task',sessionId:'sdk-child',cards:[{id:'operation',data:{operation_id:'exact-receipt'}}]}]};
  store.put('views','session',old);
  const raw=store.db.prepare("SELECT value FROM records WHERE kind='views' AND id='session'").get()?.value;
  const view=store.view('session');
  assert.ok(view.agentRuns);
  assert.equal(view.agentRuns[0].source,'native_subagent');
  assert.equal((view.cards[0].data as Record<string,unknown>).source,'native_subagent_control');
  assert.equal(view.agentRuns[0].taskId,'task');
  assert.equal(view.agentRuns[0].sessionId,'sdk-child');
  assert.equal((view.agentRuns[0].cards![0].data as Record<string,unknown>).operation_id,'exact-receipt');
  assert.equal(store.db.prepare("SELECT value FROM records WHERE kind='views' AND id='session'").get()?.value,raw);
 }finally{store.db.close();await rm(home,{recursive:true,force:true});}
});
