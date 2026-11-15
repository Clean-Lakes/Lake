import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer,type Server,type IncomingMessage,type ServerResponse} from 'node:http';
import {backendEndpoint,specialistTools,channelTools} from './mcp-stdio';
import {LakeGateway} from './gateway';

type Backend = {requests:{method:string;path:string;auth:string;body:any;waitSeconds:number}[];specialists:any[];statuses:Map<string,any>;errors:Map<string,{status:number;error:string}>;sendReceipt:any;statusDelayMs?:number};

async function fixture(t:{after(fn:()=>Promise<void>):void},tokens:{id:string;token:string}[]=[{id:'gw1',token:'lkgw-test-token'}]) {
  const home=await mkdtemp(join(tmpdir(),'lake-mcp-')),data=join(home,'web-agent');
  const backend:Backend={requests:[],specialists:[{roleId:'role_dba',roleKey:'dba',name:'数据库专员',duties:'检查数据库',projectId:'p1',sessionId:'sc_dba',revision:3},
    {roleId:'role_sre',roleKey:'sre',name:'SRE 专员',duties:'主机巡检',projectId:'p1',sessionId:'sc_sre',revision:1}],statuses:new Map(),errors:new Map(),
    sendReceipt:{instructionId:'m1',eventId:'e1',roleId:'role_dba',sessionId:'sc_dba'}};
  const server:Server=createServer((request:IncomingMessage,response:ServerResponse)=>{
    const chunks:Buffer[]=[];request.on('data',chunk=>chunks.push(chunk));request.on('end',async()=>{
      const body=chunks.length?JSON.parse(Buffer.concat(chunks).toString()):{};
      const url=new URL(request.url!,'http://localhost'),path=url.pathname,waitSeconds=Number(url.searchParams.get('waitSeconds')??0);
      backend.requests.push({method:request.method!,path,auth:String(request.headers.authorization??''),body,waitSeconds});
      const failure=backend.errors.get(path);
      if(failure){response.writeHead(failure.status);response.end(JSON.stringify({error:failure.error}));}
      else if(path==='/api/gateway/connection')response.end(JSON.stringify({ready:true,connection:{id:'test',projectId:'p1'}}));
      else if(path==='/api/gateway/specialists')response.end(JSON.stringify({specialists:backend.specialists}));
      else if(path==='/api/gateway/specialists/role_dba/instructions'||path==='/api/gateway/messages'){backend.statuses.set('m1',{state:'routing'});response.end(JSON.stringify(backend.sendReceipt));}
      else if(path.startsWith('/api/gateway/instructions/')||path.startsWith('/api/gateway/messages/')){
        const id=path.split('/').at(-1)!,status=backend.statuses.get(id);
        if(!status){response.writeHead(404);response.end(JSON.stringify({error:'外部指令不存在'}));return;}
        if(waitSeconds&&backend.statusDelayMs){
          response.writeHead(200,{'Content-Type':'application/json'});response.flushHeaders();
          setTimeout(()=>response.end(JSON.stringify(status)),backend.statusDelayMs).unref();
        }else response.end(JSON.stringify(status));
      }
      else{response.writeHead(404);response.end(JSON.stringify({error:'接口不存在'}));}
    });
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${(server.address() as any).port}`;
  await mkdir(data,{recursive:true});
  await writeFile(join(data,'runtime.json'),JSON.stringify({origin,token:'x',pid:process.pid}),{mode:0o600});
  await mkdir(join(home,'secrets'),{recursive:true,mode:0o700});
  await writeFile(join(home,'secrets','mcp-gateway.json'),JSON.stringify({version:1,tokens:tokens.map(row=>({...row,name:row.id,createdAt:'2026-11-14T00:00:00Z'}))}),{mode:0o600});
  t.after(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(home,{recursive:true,force:true});});
  return {home,backend,origin};
}

test('backendEndpoint accepts only a loopback origin and refuses missing records',async t=>{
  const f=await fixture(t);
  assert.deepEqual(backendEndpoint(f.home),{origin:f.origin});
  assert.throws(()=>backendEndpoint(join(f.home,'missing-home')),/Lake 后端未运行/);
  await writeFile(join(f.home,'web-agent','runtime.json'),JSON.stringify({origin:'http://evil.example:1'}));
  assert.throws(()=>backendEndpoint(f.home),/回环地址/);
});

test('a one-second wait bounds the long poll and returns the last status if the response body stalls',async t=>{
  const f=await fixture(t);
  f.backend.statuses.set('m1',{instructionId:'m1',state:'running',replies:[]});
  f.backend.statusDelayMs=3000;
  const wait=specialistTools({home:f.home,role:'role_dba'}).find(tool=>tool.name==='wait_instruction')!;
  const started=Date.now(),status=await wait.handler({instruction_id:'m1',timeout_seconds:1}) as any;
  assert.equal(status.state,'running');
  const polls=f.backend.requests.filter(request=>request.waitSeconds>0);
  assert.ok(polls.length>0);assert.ok(polls.every(request=>request.waitSeconds<=1));
  assert.ok(Date.now()-started<1800,'the caller budget includes fetch and response-body reads');
});

test('shared mode lists specialists and resolves the role from arguments',async t=>{
  const f=await fixture(t);
  const tools=Object.fromEntries(specialistTools({home:f.home}).map(tool=>[tool.name,tool.handler]));
  const listed=await tools.list_specialists!({}) as any;
  assert.equal(listed.specialists.length,2);assert.equal(listed.specialists[0].roleId,'role_dba');
  assert.equal(f.backend.requests[0].path,'/api/gateway/specialists');
  const receipt=await tools.send_instruction!({role:'role_dba',text:'检查磁盘',client_request_id:'abc12345'}) as any;
  assert.equal(receipt.instructionId,'m1');
  const call=f.backend.requests.at(-1)!;
  assert.equal(call.path,'/api/gateway/specialists/role_dba/instructions');
  assert.deepEqual(call.body,{text:'检查磁盘',clientRequestId:'abc12345'});
  await assert.rejects(()=>tools.send_instruction!({text:'没有角色'}),/role/);
  // The list tool only exists in shared mode.
  assert.ok(tools.list_specialists);
});

test('single-specialist mode binds the role, forwards the gateway token and waits for a reply',async t=>{
  const f=await fixture(t);
  const tools=Object.fromEntries(specialistTools({home:f.home,role:'role_dba'}).map(tool=>[tool.name,tool.handler]));
  assert.equal(tools.list_specialists,undefined,'a bound specialist does not expose the catalog');
  const receipt=await tools.send_instruction!({text:'检查磁盘'}) as any;
  assert.equal(receipt.instructionId,'m1');
  const call=f.backend.requests.find(request=>request.path.includes('/instructions'))!;
  assert.equal(call.auth,'Bearer lkgw-test-token');
  assert.equal(call.body.role,undefined,'a bound specialist never forwards a role field');
  f.backend.statuses.set('m1',{state:'running',replies:[]});
  setTimeout(()=>f.backend.statuses.set('m1',{instructionId:'m1',eventId:'e1',roleId:'role_dba',state:'replied',
    disposition:'routed',tasks:[],replies:[{text:'磁盘使用率 42%',from:'specialist',createdAt:'2026-11-14T00:00:00Z'}]}),80);
  const done=await tools.wait_instruction!({instruction_id:'m1',timeout_seconds:5}) as any;
  assert.equal(done.state,'replied');assert.equal(done.replies[0].text,'磁盘使用率 42%');
  await assert.rejects(()=>tools.get_instruction_status!({instruction_id:'missing'}),/不存在/);
  await assert.rejects(()=>tools.send_instruction!({text:'其他专员',role:'role_sre'}),/绑定专员/);
});

test('ambiguous tokens require an explicit id and backend outages surface as errors',async t=>{
  const f=await fixture(t,[{id:'gw1',token:'lkgw-a'},{id:'gw2',token:'lkgw-b'}]);
  assert.throws(()=>specialistTools({home:f.home,role:'role_dba'}),/--token-id/);
  await writeFile(join(f.home,'web-agent','runtime.json'),JSON.stringify({origin:'http://127.0.0.1:1'}));
  const tools=Object.fromEntries(specialistTools({home:f.home,role:'role_dba',tokenId:'gw1'}).map(tool=>[tool.name,tool.handler]));
  await assert.rejects(()=>tools.send_instruction!({text:'检查磁盘'}),/HTTP|网关|连接/);
});

test('channel tools expose project messaging and preserve thread, message and reply identities',async t=>{
 const f=await fixture(t),gateway=new LakeGateway(f.home),connection=gateway.createConnection({name:'Codex',projectId:'p1'});
 const tools=Object.fromEntries(channelTools({home:f.home,connectionId:connection.id}).map(tool=>[tool.name,tool]));
 assert.deepEqual(Object.keys(tools).sort(),['get_message_status','send_message','test_connection','wait_message']);
 const input={text:'检查发布',thread_id:'thread-1',thread_title:'发布前检查',client_message_id:'message-0001',reply_to:'prior-message'};
 await tools.send_message.handler(input);
 const call=f.backend.requests.at(-1)!;
 assert.equal(call.path,'/api/gateway/messages');
 assert.deepEqual(call.body,{text:'检查发布',threadId:'thread-1',threadTitle:'发布前检查',clientMessageId:'message-0001',replyTo:'prior-message'});
 assert.equal(call.auth,'Bearer '+gateway.resolveToken(connection.id).token);
 assert.equal(tools.send_message.inputSchema.safeParse({...input,project_id:'other'}).success,false);
 assert.equal(tools.send_message.inputSchema.safeParse({...input,role:'role_dba'}).success,false);
 assert.equal(tools.send_message.inputSchema.safeParse({text:'x',client_message_id:'message-0001'}).success,false);
 assert.equal(tools.send_message.inputSchema.safeParse({...input,text:'a'.repeat(16384)}).success,true);
 assert.equal(tools.send_message.inputSchema.safeParse({...input,text:'中'.repeat(5461)}).success,true);
 assert.equal(tools.send_message.inputSchema.safeParse({...input,text:'中'.repeat(5462)}).success,false);
 const before=f.backend.requests.length;
 assert.equal((await tools.test_connection.handler({}) as any).ready,true);
 assert.equal(f.backend.requests.length,before+1);assert.equal(f.backend.requests.at(-1)!.path,'/api/gateway/connection');
 assert.throws(()=>specialistTools({home:f.home,tokenId:connection.id}),/只能使用消息/);
 assert.throws(()=>channelTools({home:f.home,connectionId:'gw1'}),/原专员入口/);
});

test('channel waits bound stalled bodies and surface revoked connections instead of reporting success',async t=>{
 const f=await fixture(t),gateway=new LakeGateway(f.home),connection=gateway.createConnection({name:'Codex',projectId:'p1'});
 const tools=Object.fromEntries(channelTools({home:f.home,connectionId:connection.id}).map(tool=>[tool.name,tool.handler]));
 f.backend.statuses.set('m1',{instructionId:'m1',state:'running',tasks:[{taskId:'task-one'}],replies:[]});
 f.backend.statusDelayMs=3000;
 const started=Date.now(),status=await tools.wait_message({message_id:'m1',timeout_seconds:1}) as any;
 assert.equal(status.state,'running');assert.equal(status.tasks[0].taskId,'task-one');
 assert.ok(Date.now()-started<1800);
 assert.ok(f.backend.requests.some(request=>request.path==='/api/gateway/messages/m1'&&request.waitSeconds===1));
 f.backend.errors.set('/api/gateway/messages/m1',{status:403,error:'接入连接已停用'});
 await assert.rejects(()=>tools.wait_message({message_id:'m1',timeout_seconds:1}),/已停用/);
 gateway.updateConnection(connection.id,{enabled:false});
 assert.throws(()=>channelTools({home:f.home,connectionId:connection.id}),/已停用/);
});
