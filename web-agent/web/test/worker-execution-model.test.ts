import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {AICard,AgentRun,Resource,ResourceTreeNode,SessionSnapshot} from '../../shared/contracts';
import {nativeRunState,workerBusinessReceipts,workerExecutionModel} from '../src/workerExecutionModel';

const resource=(id:string,name='同名服务器',projectId='p')=>({id,name,projectId,kind:'ssh',status:'available'} as Resource);
const folder=(id:string,name:string,parentId:string|null=null):ResourceTreeNode=>({id,name,parentId,projectId:'p',kind:'folder',resourceId:null,position:0});
const leaf=(id:string,parentId:string|null):ResourceTreeNode=>({id:`node-${id}`,name:'',parentId,projectId:'p',kind:'resource',resourceId:id,position:1});
const call=(id:string,resourceId?:string):AICard=>({id,type:'operation',title:'inspect_host',content:'synthetic result',status:'completed',at:'2026-11-06T00:00:00Z',data:{taskId:'task',...(resourceId?{resource_id:resourceId}:{})}});
const run=(id:string,resourceIds:string[],cards:AICard[]=[]):AgentRun=>({id,source:'zcode_subagent',taskId:'task',workerId:'worker',sessionId:`child-${id}`,childSessionId:`child-${id}`,role:'general-purpose',task:'现场检查',resourceIds,cards,status:'completed',createdAt:'2026-11-06T00:00:00Z'});
function snapshot(runs:AgentRun[],cards:AICard[]=[],tree:ResourceTreeNode[]=[folder('prod','生产环境'),folder('cloud','京东云','prod'),leaf('a','cloud'),leaf('b','prod')]):SessionSnapshot{
 return {session:{id:'session',projectId:'p',workspaceRole:'worker'},superagent:{task:{taskId:'task',sessionId:'session',projectId:'p'}},resources:[resource('a'),resource('b')],resourceTree:tree,ai:{cards,agentRuns:runs}} as unknown as SessionSnapshot;
}
const flatten=(nodes:ReturnType<typeof workerExecutionModel>['resources']):ReturnType<typeof workerExecutionModel>['resources']=>nodes.flatMap(node=>[node,...flatten(node.children)]);

test('native child appears under its resource without directory levels',()=>{
 const model=workerExecutionModel(snapshot([run('one',['a'],[call('c','a')])]));
 assert.equal(model.resources.length,1);
 const node=model.resources[0];
 assert.equal(node?.name,'同名服务器');
 assert.equal(node?.resource?.id,'a');
 assert.deepEqual(node?.children,[]);
 assert.equal(node?.runs[0]?.id,'one');
 assert.equal(model.resourcePaths.get('a'),'同名服务器');
});
test('same display names never merge two resources or infer ownership from model arguments',()=>{
 const guessed={...call('guess'),data:{arguments:{asset_ref:'a'},target:'同名服务器'}};
 const model=workerExecutionModel(snapshot([run('one',['a']),run('two',['b'])],[guessed]));
 assert.equal(flatten(model.resources).filter(node=>node.resource).length,2);
 assert.deepEqual(model.taskCards.map(card=>card.id),['guess']);
});
test('a cross-resource child is retained once at task level and calls display resource names',()=>{
 const model=workerExecutionModel(snapshot([run('compare',['a','b'],[call('ca','a'),call('cb','b')])]));
 assert.deepEqual(model.taskRuns.map(run=>run.id),['compare']);
 assert.equal(flatten(model.resources).flatMap(node=>node.runs).length,0);
 assert.equal(model.resourcePaths.get('a'),'同名服务器');
 assert.equal(model.resourcePaths.get('b'),'同名服务器');
});
test('unknown, missing and conflicting resource attribution remains task-level',()=>{
 const model=workerExecutionModel(snapshot([run('unknown',['gone']),run('none',[]),run('conflict',['a'],[call('actual','b')])]));
 assert.equal(model.taskRuns.length,3);
 assert.equal(model.resources.length,0);
});
test('foreign tasks, legacy runs and duplicate native delivery do not create extra task children',()=>{
 const model=workerExecutionModel(snapshot([run('one',['a']),run('one',['a']),{...run('foreign',['b']),taskId:'other'},{...run('legacy',['b']),source:undefined}]));
 assert.deepEqual(model.runs.map(run=>run.id),['one']);
});
test('child tools and finished Agent controls are not duplicated in parent execution records',()=>{
 const childCard={...call('child','a'),data:{resource_id:'a',agentRunId:'one',taskId:'task'}};
 const model=workerExecutionModel(snapshot([run('one',['a'],[childCard])],[childCard,{...call('spawn'),title:'Agent'},{...call('active-spawn'),title:'Agent',status:'running'},call('own','b')]));
 assert.equal(flatten(model.resources).flatMap(node=>node.cards).length,1);
 assert.equal(model.taskCards.length,0);
 assert.equal(model.runs[0]?.cards?.length,1);
});
test('failed child creation remains visible while foreign operation records stay out',()=>{
 const model=workerExecutionModel(snapshot([],[{...call('spawn'),title:'Agent',status:'failed'},{...call('other'),data:{taskId:'other'}}]));
 assert.deepEqual(model.taskCards.map(card=>card.id),['spawn']);
});
test('malformed cycles and missing folders never hide a real resource execution',()=>{
 const model=workerExecutionModel(snapshot([run('one',['a']),run('two',['b'])],[],[folder('x','循环X','y'),folder('y','循环Y','x'),leaf('a','x'),leaf('b','missing')]));
 assert.deepEqual(flatten(model.resources).flatMap(node=>node.runs.map(run=>run.id)).sort(),['one','two']);
});
test('completed child with an unknown business effect keeps its resource open for attention',()=>{
 const child=run('one',['a'],[{...call('unknown-write','a'),status:'unknown'},call('later-read','a')]);
 const model=workerExecutionModel(snapshot([child]));
 assert.equal(nativeRunState(child),'unknown');
 assert.equal(model.resources[0]?.state,'unknown');
 assert.equal(nativeRunState(run('settled',['a'],[{...call('old-read','a'),status:'failed'},call('new-read','a')])),'completed','a settled diagnostic failure alone is not an unknown mutation');
 assert.equal(workerExecutionModel(snapshot([run('clean',['a'],[call('success','a')])])).resources[0]?.state,'completed');
});
test('business receipts require current-task host ledger IDs, never successful control or discovery cards',()=>{
 const oldTools=['work_begin','work_update','work_finish','list_assets','list_mcp_servers','list_mcp_tools','Read'];
 const unproven=oldTools.map((title,index)=>({...call(`unproven-${index}`),title}));
 const argumentForgery={...call('argument-forgery'),data:{taskId:'task',arguments:{operation_id:'not-a-host-receipt'}}};
 const actual={...call('actual','a'),data:{taskId:'task',resource_id:'a',operation_id:'operation-actual'}};
 const failed={...call('failed','b'),status:'failed',data:{taskId:'task',resource_id:'b',operation_id:'operation-failed'}};
 const unknown={...call('unknown','a'),status:'unknown',data:{taskId:'task',resource_id:'a',operation_id:'operation-unknown'}};
 const foreign={...call('foreign'),data:{taskId:'other',operation_id:'operation-foreign'}};
 const incomplete={...call('incomplete'),data:{operation_id:'operation-unbound'}};
 const native={...call('native'),title:'Agent',status:'failed',data:{taskId:'task',operation_id:'operation-native'}};
 const model=snapshot([run('child',['b'],[failed])],[...unproven,argumentForgery,actual,unknown,foreign,incomplete,native]);
 assert.deepEqual(workerBusinessReceipts(model).map(card=>card.id).sort(),['actual','failed','unknown']);
 assert.equal(workerExecutionModel(model).taskCards.some(card=>card.id==='unproven-0'),true,'unproven historical controls remain available in execution history');
});
test('one canonical operation produces one receipt and normal success cannot conceal its unknown projection',()=>{
 const unknown={...call('unknown','a'),status:'unknown',data:{taskId:'task',resource_id:'a',operation_id:'same-operation'}};
 const duplicate={...unknown,id:'duplicate',status:'completed'};
 const model=snapshot([run('child',['a'],[duplicate])],[unknown]);
 assert.deepEqual(workerBusinessReceipts(model).map(card=>[card.id,card.status]),[['unknown','unknown']]);
});
