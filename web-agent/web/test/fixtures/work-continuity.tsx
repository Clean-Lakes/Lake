// Real App and production components. All work state is in memory; no model,
// credentials, external job or resource command is contacted by this fixture.
import './readme-workbench';
import type {WorkGoal} from '../../../shared/contracts';
const stamp=new Date().toISOString();
const goal:WorkGoal={id:'fixture-goal',sessionId:'fixture',originRootTurnId:'work-origin',title:'发布后核对各项任务结果',status:'waiting_external',revision:1,modelRounds:13,roundLimit:500,deadlineAt:new Date(Date.now()+86400000).toISOString(),updatedAt:stamp,items:[
 {id:'publish',title:'核对已启动的发布任务',status:'waiting_external',watch:{adapter:'release-v1',operationId:'original-operation',handle:'original-order',state:'running',lastObservedAt:stamp}},
 {id:'database',title:'数据库由用户处理，等待确认',status:'waiting_user',reason:'数据库前置条件尚未确认，依赖部署不会启动。'},
 {id:'independent',title:'独立构建与验证',status:'completed'},
]};
const previous=window.fetch;
window.fetch=async(input,init)=>{
 const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url,location.href);
 const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
 if(url.pathname.endsWith('/ai/workControl')){
  const request=JSON.parse(String(init?.body));if(request.goalId!==goal.id||request.revision!==goal.revision)return json({error:'任务已更新'},409);
  goal.status=request.command==='pause'?'paused':request.command==='cancel'?'cancelled':'waiting_external';goal.revision++;return json({ok:true});
 }
 const response=await previous(input,init);
 if(url.pathname.endsWith('/snapshot')){
  const data=await response.json();goal.sessionId=data.session.id;data.session.status='completed';data.ai.status=goal.status;data.ai.rootTurnId=goal.originRootTurnId;data.ai.workGoals=[structuredClone(goal)];data.ai.agentRuns=[];data.sre={enabled:false,tasks:[],pilot:{enabled:false,automatic:false}};return json(data);
 }
 return response;
};
