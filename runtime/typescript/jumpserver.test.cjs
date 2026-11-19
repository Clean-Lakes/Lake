const {test} = require("node:test");
const assert = require("node:assert/strict");
const {randomUUID} = require("node:crypto");
const {createServer} = require("node:http");
const fs = require("node:fs/promises");
const {join} = require("node:path");
const {tmpdir} = require("node:os");
process.env.LAKE_TS_IMPORT_ONLY = "1";
const {startLakeServer} = require("../../bin/lake-runtime/server.cjs");

async function fixture(t) {
  const org = randomUUID(), otherOrg = randomUUID(), user = randomUUID(), account = randomUUID();
  const folder = randomUUID(), alias = randomUUID(), asset = randomUUID();
  const nodes = [{id:folder, key:"1", org_id:org, value:"运维"}, {id:alias, key:"1:8", org_id:org, value:"华东"}];
  const target = {id:asset, name:"开发主机", org_id:org, address:"192.0.2.33", category:{value:"host"}, nodes:[folder,alias]};
  const state = {assets:[target,{...target,id:randomUUID(),org_id:otherOrg}], nodes, denied:false, broken:false,
    username:"alice",user,accounts:[{id:account,alias:"lake",name:"运维账号",actions:[{value:"connect"}]}], tickets:[], tokenActive:true};
  const core = createServer(async (req,res)=>{
    res.setHeader("Content-Type","application/json");
    const fail = (status)=>{res.statusCode=status;res.end("{}");};
    if(req.headers.authorization!=="Bearer fixture-personal" || req.headers["x-jms-org"]!==org || state.denied)return fail(403);
    const url = new URL(req.url,"http://localhost"), path = url.pathname.replace("/api/v1/","");
    const send=v=>res.end(JSON.stringify(v));
    if(path==="users/profile/")return send({id:state.user, username:state.username});
    if(path==="perms/users/self/nodes/")return send(state.nodes);
    if(path==="perms/users/self/assets/"){
      const offset=Number(url.searchParams.get("offset"));
      if(state.broken && offset)return fail(503);
      return send({count:state.assets.length,results:state.assets.slice(offset,offset+1),next:offset+1<state.assets.length?"?offset="+(offset+1):null});
    }
    if(path==="perms/users/self/assets/"+asset+"/")return send({...target,permed_protocols:[{name:"ssh"}],permed_accounts:state.accounts});
    if(path==="authentication/connection-token/"){
      let raw="";for await(const part of req)raw+=part;
      const body=JSON.parse(raw);
      if(body.asset!==asset||!state.accounts.some(a=>a.alias===body.account)||body.protocol!=="ssh"||body.connect_method!=="ssh_client")return fail(403);
      const ticket={id:randomUUID(),value:randomUUID(),is_active:state.tokenActive,is_reusable:false};
      state.tickets.push({ticket,body});return send(ticket);
    }
    return fail(404);
  });
  await new Promise(resolve=>core.listen(0,"127.0.0.1",resolve));
  const home=await fs.realpath(await fs.mkdtemp(join(tmpdir(),"lake-jumpserver-test-")));
  const web=join(home,"web");await fs.mkdir(web);await fs.writeFile(join(web,"index.html"),"fixture");
  const app=await startLakeServer({home,data:join(home,"data"),staticRoot:web,port:0});
  t.after(async()=>{await app.close();await new Promise(resolve=>core.close(resolve));await fs.rm(home,{recursive:true,force:true});});
  const project=app.store.createProject("测试项目"), base="/api/projects/"+project.id+"/jumpserver";
  const login={origin:"http://127.0.0.1:"+core.address().port,orgId:org,authMethod:"bearer",secret:"fixture-personal"};
  const api=async(path,method="GET",body,status=200)=>{
    const res=await fetch(app.origin+path,{method,headers:{Authorization:"Bearer "+app.token,"Content-Type":"application/json"},body:body===undefined?undefined:JSON.stringify(body)});
    const data=await res.json();assert.equal(res.status,status,JSON.stringify(data));return data;
  };
  const bind=(extra={})=>api(base,"PUT",{...login,expectedRevision:0,userId:user,nodeId:null,kokoHost:"127.0.0.1",kokoPort:2222,...extra});
  const resources=()=>app.store.catalog().resources.filter(r=>r.jumpServer);
  return {app,home,state,folder,asset,alias,target,account,user,login,project,base,bind,resources,api};
}

test("personal mount reconciles complete pages, aliases, revocation and transient failures",async t=>{
  const f=await fixture(t);
  const preview=await f.api(f.base+"/preview","POST",f.login);
  assert.equal(preview.userId,f.user);assert.equal(preview.nodes[1].name,"运维 / 华东");
  const binding=await f.bind();assert.equal(binding.assetCount,1);assert.equal(binding.username,"alice");
  const [resource]=f.resources();assert.ok(resource);assert.equal(resource.ssh,undefined);
  const links=()=>f.app.store.catalog().resourceTree.filter(n=>n.resourceId===resource.id);
  assert.equal(links().length,2);
  await f.api("/api/resources/"+resource.id,"PATCH",{ssh:{host:"127.0.0.1"}},409);
  f.target.name="已改名";f.target.nodes=[f.alias];await f.api(f.base+"/sync","POST",{});
  assert.equal(f.resources()[0].id,resource.id);assert.equal(links().length,1);
  f.state.broken=true;await f.api(f.base+"/sync","POST",{},502);
  assert.equal(f.resources()[0].name,"已改名");
  assert.equal((await f.api(f.base)).binding.state,"offline");
  const other=f.app.store.createProject("隔离项目");
  assert.equal((await f.api("/api/projects/"+other.id+"/resources")).some(r=>r.id===resource.id),false);
  f.state.broken=false;f.state.denied=true;await f.api(f.base+"/sync","POST",{},403);
  assert.equal(f.resources().length,0);assert.equal(links().length,0);
  await f.api("/api/resources/"+resource.id,"GET",undefined,404);
  assert.ok(!JSON.stringify(f.app.store.list("jumpServerBindings")).includes(f.login.secret));
  f.state.denied=false;await f.api(f.base+"/sync","POST",{});assert.equal(f.resources()[0].id,resource.id);
  await f.api(f.base,"DELETE",{id:binding.id,revision:binding.revision});
  assert.equal((await f.api(f.base)).binding,null);assert.equal(f.resources().length,0);
  assert.deepEqual((await fs.readdir(join(f.home,"secrets"))).filter(n=>n.startsWith("jumpserver-")),[]);
});

test("subtree, user identity and remote accounts remain scoped to this mount",async t=>{
  const f=await fixture(t);await f.bind({nodeId:f.alias});
  const [r]=f.resources();assert.equal(f.app.store.catalog().resourceTree.filter(n=>n.resourceId===r.id).length,1);
  const api="/api/resources/"+r.id+"/jumpserver-accounts";
  assert.equal((await f.api(api)).accounts[0].id,f.account);
  await f.api(api,"PUT",{accountId:randomUUID()},409);
  await f.api(api,"PUT",{accountId:f.account});
  assert.equal(f.resources()[0].jumpServer.accountId,f.account);
  f.target.nodes=[f.folder];await f.api(f.base+"/sync","POST",{});assert.equal(f.resources().length,0);
  f.target.nodes=[f.alias];f.state.user=randomUUID();await f.api(f.base+"/sync","POST",{},403);
  assert.equal(f.resources().length,0);
});
