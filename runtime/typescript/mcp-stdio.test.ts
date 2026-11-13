import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer,type Server,type IncomingMessage,type ServerResponse} from 'node:http';
import {backendEndpoint,specialistTools} from './mcp-stdio';

type Backend = {requests:{method:string;path:string;auth:string;body:any}[];specialists:any[];statuses:Map<string,any>;sendReceipt:any};

async function fixture(t:{after(fn:()=>Promise<void>):void},tokens:{id:string;token:string}[]=[{id:'gw1',token:'lkgw-test-token'}]) {
  const home=await mkdtemp(join(tmpdir(),'lake-mcp-')),data=join(home,'web-agent');
  const backend:Backend={requests:[],specialists:[{roleId:'role_dba',roleKey:'dba',name:'数据库专员',duties:'检查数据库',projectId:'p1',sessionId:'sc_dba',revision:3},
    {roleId:'role_sre',roleKey:'sre',name:'SRE 专员',duties:'主机巡检',projectId:'p1',sessionId:'sc_sre',revision:1}],statuses:new Map(),
    sendReceipt:{instructionId:'m1',eventId:'e1',roleId:'role_dba',sessionId:'sc_dba'}};
  const server:Server=createServer((request:IncomingMessage,response:ServerResponse)=>{
    const chunks:Buffer[]=[];request.on('data',chunk=>chunks.push(chunk));request.on('end',async()=>{
      const body=chunks.length?JSON.parse(Buffer.concat(chunks).toString()):{};
      const path=request.url!.split('?')[0]!;
      backend.requests.push({method:request.method!,path,auth:String(request.headers.authorization??''),body});
      if(path==='/api/gateway/specialists')response.end(JSON.stringify({specialists:backend.specialists}));
      else if(path==='/api/gateway/specialists/role_dba/instructions'){backend.statuses.set('m1',{state:'routing'});response.end(JSON.stringify(backend.sendReceipt));}
      else if(path.startsWith('/api/gateway/instructions/')){
        const id=path.split('/').at(-1)!,status=backend.statuses.get(id);
        if(!status){response.writeHead(404);response.end(JSON.stringify({error:'外部指令不存在'}));return;}
        response.end(JSON.stringify(status));
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
