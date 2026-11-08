import assert from "node:assert/strict";
import test from "node:test";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {LakeStore} from "./store";
import {digest,type Goal} from "./tasks";
import {workerDeliveries} from "./worker-deliveries";

test("raw Worker reads the frozen delivery once per exact invocation across roles, retries and restart",async t=>{
  const home=await mkdtemp(join(tmpdir(),"worker-delivery-")),store=await LakeStore.open(home,join(home,"data"));
  t.after(async()=>{store.db.close();await rm(home,{recursive:true,force:true});});
  const goal={id:"member",sharedTaskId:"joint",roleId:"ops",sessionId:"run",workerId:"worker",projectId:"project"} as Goal;
  store.put("superProjects","project",{routerSessionId:"pilot"});
  const add=(revision:number,root:string,text:string,workerId="worker",taskId="joint",destination="channel")=>{
    const key=digest([goal.id,revision]),id="report_"+digest([key,destination]);
    store.put("superReports",key,{key,goalRevision:revision,workerId});
    store.put("messages",id,{id,role:"assistant",sessionId:destination,text,author:{workerId,sessionId:"run",roleId:"ops",taskId,channelSessionId:"channel",rootTurnId:root}});
  };
  add(1,"first","first round failed");add(2,"retry","old published version");add(3,"retry","final findings");
  add(3,"retry","pilot copy","worker","joint","pilot");
  add(4,"empty","unrelated worker","sibling");add(5,"other","unrelated task","worker","unrelated");
  add(6,"","ungrouped legacy report");add(7,"new","Pilot-only delivery","worker","member","pilot");
  const reports=workerDeliveries(store,goal,"channel");
  assert.deepEqual(reports.map(r=>r.text),["first round failed","final findings","Pilot-only delivery"]);
  assert.ok(reports.every(m=>m.author?.workerId===goal.workerId));
  assert.equal(store.list("messages").length,8);
  const missing=store.require<any>('messages','report_'+digest([digest([goal.id,5]),'channel']));
  delete missing.author.taskId;
  store.put('messages',missing.id,missing);
  assert.deepEqual(workerDeliveries(store,{...goal,sharedTaskId:undefined},'channel').map(r=>r.text),['Pilot-only delivery']);
});
