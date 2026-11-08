import assert from "node:assert/strict";
import {test} from "node:test";
import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {LakeStore} from "./store";
import {projectTaskProgress} from "./task-progress";
import type {Goal} from "./tasks";

test("parked task progress preserves historical unknowns and real command handles", async t => {
  const home=await mkdtemp(join(tmpdir(),"lake-progress-"));
  const store=await LakeStore.open(home,join(home,"data"));
  t.after(async()=>{store.db.close();await rm(home,{recursive:true,force:true});});
  const item={id:"step",title:"恢复探针",status:"running",attemptId:"verification",dependsOn:[],evidenceIds:[]};
  const goal={id:"goal",sessionId:"session",projectId:"project",status:"blocked",items:[item]} as unknown as Goal;
  const scope={goalId:goal.id,sessionId:goal.sessionId,projectId:goal.projectId,stepId:item.id};
  for (const [id,generation,retryOf] of [["change",2,undefined],["verification",4,"change"]] as const)
    store.put("superAttempts",id,{...scope,id,generation,retryOf,state:"running",createdAt:new Date(generation).toISOString()});
  store.put("superOperations","prior",{...scope,id:"prior",status:"unknown",attemptId:"change"});
  const owner={state:"parked",generation:4};
  const progress=(liveId?:string)=>projectTaskProgress(store,goal,owner,id=>id===liveId)[0]!;
  assert.equal(progress().status,"blocked");
  assert.deepEqual(progress().attempts?.map(a=>a.status),["unknown","blocked"]);
  assert.equal(item.status,"running");
  assert.equal(store.require<any>("superAttempts","change").state,"running");

  store.put("superOperations","read",{...scope,id:"read",status:"dispatched",attemptId:"verification",commandExecutionId:"command"});
  assert.equal(progress("another-command").status,"waiting_external");
  assert.equal(progress("command").status,"running");
  store.put("superOperations","read",{...scope,id:"read",status:"succeeded",attemptId:"verification"});
  for(const expected of ["paused","waiting_external","waiting_user","cancelled","failed"]){
    goal.status=expected;
    assert.equal(progress().status,expected);
  }
  goal.status="completed";
  assert.equal(progress().status,"ended");
  owner.state="active";goal.status="running";
  assert.equal(progress().status,"running");
  assert.equal(progress().attempts?.[0]?.status,"unknown");
  owner.generation=5;
  assert.equal(progress().status,"ended");
  goal.items[0]!.status="completed";
  assert.equal(progress().status,"completed");
});
