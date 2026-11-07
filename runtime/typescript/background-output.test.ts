import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LakeExecution } from "./execution";
import { LakeSecurity } from "./security";
import { LakeStore } from "./store";
import { digest } from "./tasks";
import type { ToolEntry, ToolExecutionContext } from "./sdk";

const missing = {result: false, errorCode: 2, message: "No task found"} as const;
const sdk = {metadata: {name: "TaskOutput"}, validateInput: () => missing, handler: async () => missing} as unknown as ToolEntry;
const context = {abortSignal: new AbortController().signal, runtimeTaskRegistry: {get: () => undefined}} as unknown as ToolExecutionContext;

async function fixture(t: TestContext) {
  const home = await mkdtemp(join(tmpdir(),"lake-background-output-"));
  const store = await LakeStore.open(home,join(home,"data"));
  t.after(async () => {store.close(); await rm(home,{recursive: true,force: true});});
  const project = store.createProject("background output");
  const session = store.createSession(project.id), resource = store.catalog().resources.find(r => r.projectId === project.id)!;
  const execution = new LakeExecution(store,new LakeSecurity(store), {} as never, value=>value);
  const owner = {id: "worker", taskId: "original-task", sessionId: session.id, projectId: project.id, generation: 2};
  const call = "original-bash-call", commandId = digest([owner.taskId,1,call]), handle = "exec_test-background-id";
  const result = {status: "cancelled", exitCode: 137, cancelled: true, stdout: {text: "started"}, stderr: {text: ""}};
  const record = {id: commandId, sessionId: session.id, taskId: owner.taskId, workerId: owner.id, generation: 1,
    resourceId: resource.id, resourceRevision: 1, configurationRevision: execution.revision(resource),
    backgroundTaskId: handle, readOnly: false, result, status: result.status, finishedAt: new Date().toISOString()};
  const operation = {id: digest([session.id,call]), tool: "Bash", callId: call, sessionId: session.id, goalId: owner.taskId,
    generation: 1, projectId: project.id, resourceId: resource.id, resourceRevision: 1, hostConfigurationHash: record.configurationRevision,
    status: "unknown", commandExecutionId: commandId, output: result, outputHash: digest(result), completedAt: record.finishedAt};
  store.put("commandExecutions",record.id,record);
  store.put("superOperations",operation.id,operation);
  const input = {task_id: handle, block: true, timeout: 5000};
  return {store,execution,owner,record,operation,resource,input,handle};
}

test("TaskOutput reads an originally issued terminal handle from an earlier invocation of the same worker without changing its unknown operation",async t=>{
  const {store,execution,owner,record,operation,resource,input,handle} = await fixture(t);
  const entry = execution.taskOutput(sdk,owner);
  // Historical SSH foreground executions also had internal handles. Registry loss alone is insufficient.
  assert.deepEqual(entry.validateInput!(input,context),missing);
  const view=store.view(owner.sessionId);
  view.cards.push({id:"original-card",type:"operation",title:"Bash",status:"completed",at:record.finishedAt,
    data:{call_id:operation.callId},content:`Command did not complete within its 120s timeout and was moved to the background (ID: ${handle}). You will be notified when it completes.`});
  store.put("views",owner.sessionId,view);
  assert.deepEqual(entry.validateInput!(input,context),{result:true});
  const read=await entry.handler(input,context) as {task:{exitCode:number;status:string;output:string;description:string}};
  assert.equal(read.task.exitCode,137);assert.equal(read.task.status,"cancelled");assert.equal(read.task.output,"started");
  assert.match(read.task.description,/待核实/);
  assert.deepEqual(store.require("superOperations",operation.id),operation);
  // No new execution, stop route, or mutable registry object is installed.
  assert.equal(store.list("commandExecutions").length,1);
  const stop={...sdk,metadata:{...sdk.metadata,name:"TaskStop"}};
  assert.equal(execution.taskOutput(stop,owner),stop);
  store.put("resourceRevisions",resource.id,2);
  assert.throws(()=>entry.validateInput!(input,context),/已变化/);
});

test("current scope, original generation, authoritative operation output and live SDK ownership fence archived handles",async t=>{
  const {store,execution,owner,record,operation,input} = await fixture(t);
  store.put("commandExecutions",record.id,{...record,publishedBackground:true});
  const entry=execution.taskOutput(sdk,owner);
  assert.deepEqual(entry.validateInput!(input,context),{result:true});
  for (const ownerChange of [{taskId:"unrelated"},{sessionId:"sibling"},{id:"other-worker"},{generation:0},{targetResourceIds:["other-resource"]}]) {
    const foreign=execution.taskOutput(sdk,{...owner,...ownerChange});
    assert.deepEqual(await foreign.handler(input,context),missing);
  }
  assert.deepEqual(await entry.handler({task_id:"made-up"},context),missing);
  const activeContext = {...context,runtimeTaskRegistry:{get:()=>({status:"running"})}} as unknown as ToolExecutionContext;
  assert.deepEqual(await entry.handler(input,activeContext),missing);
  for (const changed of [{generation:2},{commandExecutionId:"foreign"},{callId:"other-call"},{outputHash:"forged"},{status:"dispatched"},{childSessionId:"child"}]) {
    store.put("superOperations",operation.id,{...operation,...changed});
    assert.deepEqual(entry.validateInput!(input,context),missing);
  }
  store.put("superOperations",operation.id,operation);
  store.put("legacyProjectPolicies",owner.projectId,{data:{Mode:"restricted"}});
  assert.throws(()=>entry.validateInput!(input,context),/原项目策略/);
});
