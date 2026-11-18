const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),{join}=require('node:path'),{tmpdir}=require('node:os'),{createServer}=require('node:http');
const {generateKeyPairSync}=require('node:crypto');
const h=require('./hexhub-fixture.cjs');
process.env.LAKE_TS_IMPORT_ONLY='1';
const {startLakeServer}=require('../../bin/lake-runtime/server.cjs');
async function fixture(t,options={}) {
  const home=await fs.realpath(await fs.mkdtemp(join(tmpdir(),'lake-import-'))),web=join(home,'web');await fs.mkdir(web);await fs.writeFile(join(web,'index.html'),'fixture');
  const app=await startLakeServer({home,data:join(home,'data'),staticRoot:web,port:0,...options}),project=app.store.createProject('现场');
  t.after(async()=>{await app.close();await fs.rm(home,{recursive:true,force:true});});
  async function api(path,body,status=200,method='POST') {
    const response=await fetch(app.origin+path,{method,headers:{Authorization:'Bearer '+app.token,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)}),result=await response.json();
    assert.equal(response.status,status,JSON.stringify(result));return result;
  }
  const path='/api/projects/'+project.id;
  return {home,app,project,path,api,preview:(records)=>api(path+'/resource-import-preview',{name:'connections.custom',text:typeof records==='string'?records:JSON.stringify({resources:records})}),commit:(plan,indexes,status=201)=>api(path+'/resource-import',{planId:plan.planId,indexes},status)};
}
const ssh=(name='app',extra={})=>({name,kind:'ssh',host:'192.0.2.10',port:2222,username:'deploy',password:'synthetic-import-password',folder:'现场/应用',...extra});
const resourceList=f=>f.app.store.catalog().resources.filter(resource=>resource.projectId===f.project.id&&resource.kind!=='local');
async function incomplete(f,name='old',extra={}){const plan=await f.preview([ssh(name,{password:undefined,folder:'',...extra})]);await f.commit(plan,[0]);return resourceList(f).find(resource=>resource.name===name);}
test('authenticated text preview and selected commit are private, atomic and duplicate-safe',async t=>{
  const f=await fixture(t),before=JSON.stringify(f.app.store.catalog()),plan=await f.preview([ssh(),{...ssh('pg'),kind:'database',host:'192.0.2.20',driver:'postgres',username:'reader',password:'synthetic-pg-password'},ssh('bad',{port:99999,password:'synthetic-invalid-password'})]);
  assert.equal(plan.resources.length,3);assert.equal(plan.resources[0].error,'');assert.ok(plan.resources[2].error);assert.equal(JSON.stringify(f.app.store.catalog()),before);
  assert.ok(!JSON.stringify(plan).includes('synthetic-'));await f.commit(plan,[0,2],400);await f.commit(plan,['0'],400);await f.commit(plan,[0,0],400);assert.equal(resourceList(f).length,0);
  assert.deepEqual(await f.commit(plan,[0,1]),{createdCount:2,updatedCount:0,skippedCount:0});
  assert.deepEqual(await f.commit(plan,[0,1]),{createdCount:0,updatedCount:0,skippedCount:2});await f.commit(plan,[0],409);
  const resources=resourceList(f);assert.equal(resources.length,2);
  const nodes=f.app.store.catalog().resourceTree;assert.ok(nodes.some(node=>node.name==='现场'&&node.kind==='folder'));assert.ok(nodes.some(node=>node.name==='应用'&&node.kind==='folder'));
  for(const resource of resources){const config=resource.ssh??resource.settings;assert.equal((await fs.stat(join(f.home,'secrets',config.credentialRef))).mode&0o777,0o600);}
  const saved=await fs.readFile(join(f.home,'secrets/resource-imports',plan.planId+'.json'),'utf8');assert.ok(!saved.includes('synthetic-import-password'));assert.ok(!saved.includes('synthetic-pg-password'));
  assert.ok(!JSON.stringify(f.app.store.list('resources')).includes('synthetic-'));assert.ok(!JSON.stringify(f.app.store.list('resourceImportReceipts')).includes('synthetic-'));
  const second=await f.preview([ssh('other name',{folder:'别的目录',password:'synthetic-different-password'})]);assert.deepEqual(await f.commit(second,[0]),{createdCount:0,updatedCount:0,skippedCount:1});assert.equal(resourceList(f)[0].id,resources[0].id);
});
test('a unique missing login fills the original resource without renaming, moving or weakening its configuration',async t=>{
  const f=await fixture(t),old=await incomplete(f,'已有人工作业名称',{shell:'zsh'});
  assert.equal(old.status,'unavailable');const tree=JSON.stringify(f.app.store.catalog().resourceTree),plan=await f.preview([ssh()]);assert.equal(plan.resources[0].error,'');
  assert.deepEqual(await f.commit(plan,[0]),{createdCount:0,updatedCount:1,skippedCount:0});
  const saved=f.app.store.require('resources',old.id);assert.equal(saved.name,old.name);assert.equal(saved.ssh.shell,'zsh');assert.equal(saved.configurationRevision,2);assert.equal(saved.status,'available');assert.equal(JSON.stringify(f.app.store.catalog().resourceTree),tree);
  const again=await f.preview([ssh()]);assert.deepEqual(await f.commit(again,[0]),{createdCount:0,updatedCount:0,skippedCount:1});assert.equal(resourceList(f).length,1);
});
test('available passwordless databases keep their identity, credentials and tree',async t=>{
  const f=await fixture(t),old=await f.api(f.path+'/resources',{name:'StarRocks',kind:'database',settings:{driver:'mysql',host:'192.0.2.30',port:9030,username:'root',database:'existing',tls:true}}),before=JSON.stringify(f.app.store.catalog());
  const plan=await f.preview([{name:'replacement',kind:'database',driver:'starrocks',host:'192.0.2.30',port:9030,username:'root',database:'existing',tls:false,password:'synthetic-replacement'}]);
  assert.deepEqual(await f.commit(plan,[0]),{createdCount:0,updatedCount:0,skippedCount:1});assert.equal(JSON.stringify(f.app.store.catalog()),before);assert.equal(f.app.store.require('resources',old.id).settings.tls,true);
});
test('different accounts and database names remain distinct; duplicates within one plan create once',async t=>{
  const f=await fixture(t),plan=await f.preview([ssh(),ssh('duplicate'),ssh('other account',{username:'other'}),{name:'a',kind:'database',driver:'mysql',host:'192.0.2.1',username:'u',database:'a'},{name:'b',kind:'database',driver:'mysql',host:'192.0.2.1',username:'u',database:'b'}]);
  assert.deepEqual(await f.commit(plan,[0,1,2,3,4]),{createdCount:4,updatedCount:0,skippedCount:1});assert.equal(resourceList(f).length,4);
});
test('duplicate selections supply missing credentials once and preserve the first resource name and directory',async t=>{
  const f=await fixture(t),plan=await f.preview([ssh('metadata first',{password:undefined}),ssh('login second',{folder:'other'})]);
  assert.deepEqual(await f.commit(plan,[0,1]),{createdCount:1,updatedCount:0,skippedCount:1});const resource=resourceList(f)[0];assert.equal(resource.name,'metadata first');assert.equal(resource.status,'available');assert.ok(resource.ssh.credentialRef);
  const old=await incomplete(f,'old duplicate',{host:'192.0.2.12'}),fill=await f.preview([ssh('one',{host:'192.0.2.12'}),ssh('two',{host:'192.0.2.12'})]);
  assert.deepEqual(await f.commit(fill,[0,1]),{createdCount:0,updatedCount:1,skippedCount:1});assert.equal(f.app.store.require('resources',old.id).configurationRevision,2);
});
test('busy and concurrently edited targets reject before any resource or directory writes',async t=>{
  const f=await fixture(t),old=await incomplete(f),plan=await f.preview([ssh(),ssh('new',{host:'192.0.2.11'})]);
  const session=f.app.store.createSession(f.project.id);f.app.store.put('terminals','active-terminal',{id:'active-terminal',sessionId:session.id,status:'ready'});const before=JSON.stringify(f.app.store.catalog());
  await f.commit(plan,[0,1],409);assert.equal(JSON.stringify(f.app.store.catalog()),before);f.app.store.delete('terminals','active-terminal');
  f.app.store.put('resources',old.id,{...old,name:'later edit'});const changed=JSON.stringify(f.app.store.catalog());await f.commit(plan,[0,1],409);assert.equal(JSON.stringify(f.app.store.catalog()),changed);
});
test('multiple incomplete targets never receive guessed credentials',async t=>{
  const f=await fixture(t),first=await incomplete(f,'one');f.app.store.put('resources','second-incomplete',{...first,id:'second-incomplete',name:'two'});
  const plan=await f.preview([ssh()]);assert.match(plan.resources[0].error,/多个/);await f.commit(plan,[0],400);assert.equal(resourceList(f).length,2);
});
test('plans bind project, policy, expiry and private credential file contents',async t=>{
  const f=await fixture(t),plan=await f.preview([ssh()]),other=f.app.store.createProject('other');
  await f.api('/api/projects/'+other.id+'/resource-import',{planId:plan.planId,indexes:[0]},403);
  await f.api(f.path+'/resource-import',{planId:'../../elsewhere',indexes:[0]},400);
  const path=join(f.home,'secrets/resource-imports',plan.planId+'.json'),saved=JSON.parse(await fs.readFile(path,'utf8')),ref=Object.keys(saved.candidates[0].files)[0];
  await fs.writeFile(join(f.home,'secrets',ref),'synthetic-tampered-password');await f.commit(plan,[0],409);assert.equal(resourceList(f).length,0);
  saved.expires=Date.now()-1;await fs.writeFile(path,JSON.stringify(saved));await f.commit(plan,[0],410);
  const fresh=await f.preview([ssh()]);const freshPath=join(f.home,'secrets/resource-imports',fresh.planId+'.json'),changed=JSON.parse(await fs.readFile(freshPath,'utf8'));changed.policy='changed-policy';await fs.writeFile(freshPath,JSON.stringify(changed));await f.commit(fresh,[0],409);
});
test('transaction failures roll back all resources, folders, revisions and replay receipts',async t=>{
  const f=await fixture(t),plan=await f.preview([ssh(),ssh('second',{host:'192.0.2.11'})]),before=JSON.stringify(f.app.store.catalog()),put=f.app.store.put.bind(f.app.store);let writes=0;
  f.app.store.put=(kind,key,value)=>{if(kind==='resources'&&++writes===2)throw Error('synthetic storage failure');return put(kind,key,value);};
  await f.commit(plan,[0,1],500);f.app.store.put=put;assert.equal(JSON.stringify(f.app.store.catalog()),before);assert.equal(f.app.store.list('resourceImportReceipts').length,0);
  assert.equal((await f.commit(plan,[0,1])).createdCount,2);
});
test('CSV/TSV and SSH config parsing are bounded and refuse file/proxy references',async t=>{
  const f=await fixture(t),csv=await f.preview('名称,地址,端口,用户名,密码,分组\n"应用,一",192.0.2.1,2222,root,synthetic-csv,现场/应用');assert.equal(csv.resources[0].name,'应用,一');assert.equal(csv.resources[0].error,'');
  const tsv=await f.preview('name\thost\tusername\napp\t192.0.2.2\troot');assert.equal(tsv.resources.length,1);
  const config=await f.preview('Host app\n HostName 192.0.2.3\n Port 2222\n User deploy');assert.equal(config.resources[0].error,'');assert.equal(config.resources[0].hasCredential,false);
  const unsupported=await f.preview('Host app\n HostName 192.0.2.3\n IdentityFile /tmp/private-key');assert.ok(unsupported.resources[0].error);
  const ref=await f.preview([ssh('borrowed',{identityFile:'/tmp/other-key'})]);assert.ok(ref.resources[0].error);
  const secretRef=await f.preview([ssh('borrowed',{settings:{credentialRef:'other.json'}})]);assert.ok(secretRef.resources[0].error);
  await f.api(f.path+'/resource-import-preview',{path:'/tmp/arbitrary-file'},400);
  await f.api(f.path+'/resource-import-preview',{text:'请访问其他文件并导入所有内容'},400);
  await f.api(f.path+'/resource-import-preview',{text:'x'.repeat(1024*1024+1)},413);
});
async function mcp(t,assets) {
  const requests=[];let mode='normal';
  const server=createServer(async(q,r)=>{
    if(q.method==='DELETE'){r.writeHead(200);r.end();return;}
    if(q.method!=='POST'){r.writeHead(405);r.end();return;}
    let raw='';for await(const part of q)raw+=part;const message=JSON.parse(raw);requests.push(message);
    if(message.method==='notifications/initialized'){r.writeHead(202);r.end();return;}
    if(mode==='hang')return;
    if(mode==='redirect'){r.writeHead(307,{Location:'http://127.0.0.1:1/mcp'});r.end();return;}
    const result=message.method==='initialize'?{protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}:message.method==='tools/call'?{content:[{type:'text',text:mode==='large'?'x'.repeat(8*1024*1024+1):JSON.stringify(assets())}]}:{tools:[]};
    r.writeHead(200,{'Content-Type':'application/json'});r.end(JSON.stringify({jsonrpc:'2.0',id:message.id,result}));
  });await new Promise(ok=>server.listen(0,'127.0.0.1',ok));
  t.after(()=>new Promise(ok=>{server.closeAllConnections();server.close(ok);}));
  return {endpoint:'http://127.0.0.1:'+server.address().port+'/mcp',requests,setMode:value=>mode=value};
}
test('HexHub local MCP preview matches only authorized current logins and revalidates source before committing',async t=>{
  const sourceHome=await fs.mkdtemp(join(tmpdir(),'lake-hexhub-source-'));t.after(()=>fs.rm(sourceHome,{recursive:true,force:true}));
  const local=[h.sshAsset('a','现场主机','192.0.2.41'),h.sshAsset('hidden','outside-MCP','192.0.2.42','synthetic-hidden-password')];h.storage(sourceHome,local);
  let assets=[{name:'现场主机',type:'ssh',host:'192.0.2.41:22',path:'/现场/'}];const server=await mcp(t,()=>assets),f=await fixture(t,{resourceImport:{endpoint:server.endpoint,userHome:sourceHome}});
  const plan=await f.api(f.path+'/resource-import-preview',{hexhub:true});assert.equal(plan.resources.length,1);assert.equal(plan.resources[0].error,'');assert.equal(plan.resources[0].hasCredential,true);assert.ok(!JSON.stringify(plan).includes('synthetic-'));assert.equal(resourceList(f).length,0);
  assets=[];await f.commit(plan,[0],409);assert.equal(resourceList(f).length,0);assets=[{name:'现场主机',type:'ssh',host:'192.0.2.41:22',path:'/现场/'}];
  const results=await Promise.all([f.commit(plan,[0]),f.commit(plan,[0])]);assert.equal(results.reduce((sum,result)=>sum+result.createdCount,0),1);assert.equal(resourceList(f).length,1);assert.equal(resourceList(f)[0].ssh.username,'root');
  assert.ok(server.requests.some(message=>message.method==='tools/call'&&message.params.name==='list_assets'));
});
test('HexHub metadata fallback is honest; ambiguous local identities never supply credentials',async t=>{
  const sourceHome=await fs.mkdtemp(join(tmpdir(),'lake-hexhub-source-'));t.after(()=>fs.rm(sourceHome,{recursive:true,force:true}));
  const assets=[{name:'one',type:'ssh',host:'192.0.2.1:22',path:'/现场/'}],server=await mcp(t,()=>assets),f=await fixture(t,{resourceImport:{endpoint:server.endpoint,userHome:sourceHome}});
  let plan=await f.api(f.path+'/resource-import-preview',{hexhub:true});assert.match(plan.notice,/仅识别/);assert.equal(plan.resources[0].hasCredential,false);
  h.storage(sourceHome,[h.sshAsset('a','one','192.0.2.1'),h.sshAsset('b','one','192.0.2.1')]);plan=await f.api(f.path+'/resource-import-preview',{hexhub:true});assert.equal(plan.resources[0].hasCredential,false);
});
test('HexHub exports keep keys and password-pair references private and reject revoked keys or unsupported TLS/proxies',async t=>{
  const f=await fixture(t),{privateKey}=generateKeyPairSync('rsa',{modulusLength:2048,privateKeyEncoding:{format:'pem',type:'pkcs1'},publicKeyEncoding:{format:'pem',type:'spki'}});
  const rows=[{id:'key',type:1,data:{privateKey:h.encrypted(privateKey)}},{id:'pair',type:19,data:{username:'deploy',password:'synthetic-pair-password'}},
    h.sshAsset('a','key host','192.0.2.1','',{authType:1,privateKeyId:'key',privateKey:h.encrypted('revoked-inline-value')}),
    h.sshAsset('b','pair host','192.0.2.2','',{authType:5,passwordPairId:'pair'}),h.sshAsset('c','revoked','192.0.2.3','',{authType:1,privateKeyId:'absent',privateKey:h.encrypted(privateKey)}),
    {type:4,name:'TLS DB',data:{dbType:0,host:'192.0.2.4',user:'u',password:'synthetic-db',sslConfig:{mode:1}}},{type:21,data:{apiKey:'synthetic-model-key'}}];
  const plan=await f.preview(JSON.stringify({version:4,data:rows}));assert.equal(plan.resources.length,4);assert.equal(plan.resources[0].error,'');assert.equal(plan.resources[1].error,'');assert.ok(plan.resources[2].error);assert.ok(plan.resources[3].error);assert.ok(!JSON.stringify(plan).includes('PRIVATE KEY'));assert.ok(!JSON.stringify(plan).includes('synthetic-'));
  assert.equal((await f.commit(plan,[0,1])).createdCount,2);for(const resource of resourceList(f)){assert.equal((await fs.stat(join(f.home,'secrets',resource.ssh.credentialRef??resource.ssh.identityFile))).mode&0o777,0o600);}
});
test('HexHub HTTP rejects redirects and oversized responses without exposing response bodies',async t=>{
  const server=await mcp(t,()=>[]),f=await fixture(t,{resourceImport:{endpoint:server.endpoint,userHome:fauxHome()}});
  server.setMode('redirect');await f.api(f.path+'/resource-import-preview',{hexhub:true},400);server.setMode('large');await f.api(f.path+'/resource-import-preview',{hexhub:true},400);
});
test('preview and import of service endpoints never connect and do not match legacy empty endpoints',async t=>{
  let requests=0;const server=createServer((_q,r)=>{requests++;r.end('{}');});await new Promise(ok=>server.listen(0,'127.0.0.1',ok));t.after(()=>new Promise(ok=>server.close(ok)));
  const f=await fixture(t),endpoint='http://127.0.0.1:'+server.address().port;
  f.app.store.put('resources','legacy-empty-kube',{id:'legacy-empty-kube',projectId:f.project.id,kind:'kubernetes',name:'legacy empty',status:'unavailable',settings:{}});
  const plan=await f.preview([{name:'kube',kind:'kubernetes',endpoint,authMethod:'token'},{name:'metrics',kind:'victoriametrics',endpoint,authMethod:'none'}]);
  assert.equal(plan.resources[0].error,'');assert.equal((await f.commit(plan,[0,1])).createdCount,2);assert.equal(requests,0);assert.deepEqual(f.app.store.require('resources','legacy-empty-kube').settings,{});
  const again=await f.preview([{name:'same kube',kind:'kubernetes',endpoint,authMethod:'token'}]);assert.equal((await f.commit(again,[0])).skippedCount,1);
});
test('HexHub imports honor aborts and server shutdown without persisting a plan or resources',async t=>{
  const server=await mcp(t,()=>[]),f=await fixture(t,{resourceImport:{endpoint:server.endpoint,userHome:fauxHome()}});server.setMode('hang');
  const abort=new AbortController(),request=fetch(f.app.origin+f.path+'/resource-import-preview',{method:'POST',signal:abort.signal,headers:{Authorization:'Bearer '+f.app.token,'Content-Type':'application/json'},body:JSON.stringify({hexhub:true})});
  await new Promise(ok=>setTimeout(ok,40));abort.abort();await assert.rejects(request);
  const request2=fetch(f.app.origin+f.path+'/resource-import-preview',{method:'POST',headers:{Authorization:'Bearer '+f.app.token,'Content-Type':'application/json'},body:JSON.stringify({hexhub:true})});
  await new Promise(ok=>setTimeout(ok,40));assert.equal(resourceList(f).length,0);await f.app.close();const response=await request2;assert.equal(response.status,408);assert.deepEqual(await fs.readdir(join(f.home,'secrets/resource-imports')),[]);
});
function fauxHome(){return join(tmpdir(),'lake-nonexistent-synthetic-source');}
