const {test} = require("node:test");
const assert = require("node:assert/strict");
const {createHmac,randomUUID} = require("node:crypto");
const {createServer} = require("node:http");
const {createServer: createHttpsServer} = require("node:https");
const childProcess = require("node:child_process");
const {execFileSync} = childProcess;
const {PassThrough} = require("node:stream");
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
    username:"alice",user,accounts:[{id:account,alias:"lake",name:"运维账号",actions:[{value:"connect"}]}], tickets:[], tokenActive:true, ticketFields:{}, keyId:randomUUID()};
  const core = createServer(async (req,res)=>{
    res.setHeader("Content-Type","application/json");
    const fail = (status)=>{res.statusCode=status;res.end("{}");};
    const signed = "(request-target): " + req.method.toLowerCase() + " " + req.url + "\naccept: application/json\ndate: " + req.headers.date;
    const signature = createHmac("sha256","fixture-personal").update(signed).digest("base64");
    const access = 'Signature keyId="'+state.keyId+'",algorithm="hmac-sha256",headers="(request-target) accept date",signature="'+signature+'"';
    if(!["Bearer fixture-personal",access].includes(req.headers.authorization) || req.headers["x-jms-org"]!==org || state.denied)return fail(403);
    const url = new URL(req.url,"http://localhost"), path = url.pathname.replace("/api/v1/","");
    const send=v=>res.end(JSON.stringify(v));
    if(path==="users/profile/")return send({id:state.user, username:state.username});
    if(path==="perms/users/self/nodes/")return send([{id:"favorite",key:"favorite",value:"收藏夹"}, ...state.nodes]);
    if(path==="perms/users/self/assets/"){
      const offset=Number(url.searchParams.get("offset"));
      if(state.broken && offset)return fail(503);
      if (url.searchParams.get("is_active") !== "true") return fail(400);
      const assets = state.assets.filter(a => url.searchParams.get("protocols")!=="ssh" || a.id===asset);
      return send({count:assets.length,results:assets.slice(offset,offset+1),next:offset+1<assets.length?"?offset="+(offset+1):null});
    }
    if(path==="perms/users/self/assets/"+asset+"/")return send({...target,permed_protocols:[{name:"ssh"}],permed_accounts:state.accounts});
    if(path==="authentication/connection-token/"){
      let raw="";for await(const part of req)raw+=part;
      const body=JSON.parse(raw);
      if(body.asset!==asset||!state.accounts.some(a=>a.alias===body.account)||body.protocol!=="ssh"||body.connect_method!=="ssh_client")return fail(403);
      const ticket={id:randomUUID(),value:randomUUID(),is_active:state.tokenActive,is_reusable:false,user,org_id:org,...body,...state.ticketFields};
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

test("HTTPS accepts an imported server certificate and still verifies the peer name before sending credentials", async t => {
  const f = await fixture(t);
  const openssl = args => execFileSync("openssl", args, {cwd: f.home, stdio: "ignore", timeout: 15000});
  openssl(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=Test CA",
    "-addext", "basicConstraints=critical,CA:TRUE", "-keyout", "ca.key", "-out", "ca.pem"]);
  openssl(["req", "-new", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=127.0.0.1",
    "-keyout", "server.key", "-out", "server.csr"]);
  await fs.writeFile(join(f.home, "extensions"), "basicConstraints=critical,CA:FALSE\nextendedKeyUsage=serverAuth\nsubjectAltName=IP:127.0.0.1\n");
  openssl(["x509", "-req", "-in", "server.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-set_serial", "1", "-days", "1",
    "-extfile", "extensions", "-out", "server.pem"]);

  const [key, cert, ca] = await Promise.all(["server.key", "server.pem", "ca.pem"].map(name => fs.readFile(join(f.home, name), "utf8")));
  let requests = 0;
  const endpoint = createHttpsServer({key, cert}, (req, res) => {
    requests++;
    assert.equal(req.headers.authorization, "Bearer " + f.login.secret);
    const value = req.url === "/api/v1/users/profile/" ? {id: f.user, username: "alice"} : [];
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(value));
  });
  await new Promise(resolve => endpoint.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => endpoint.close(resolve)));
  const port = endpoint.address().port;
  const login = {...f.login, origin: "https://127.0.0.1:" + port};
  const preview = (config, status) => f.api(f.base + "/preview", "POST", config, status);

  assert.match((await preview(login, 502)).error, /HTTPS 证书未受信/);
  assert.equal(requests, 0);
  assert.equal((await preview({...login, ca}, 200)).userId, f.user);
  assert.equal((await preview({...login, ca: cert}, 200)).userId, f.user);
  assert.equal(requests, 4);
  assert.match((await preview({...login, ca: cert, origin: "https://localhost:" + port}, 502)).error, /证书与 API 地址不匹配/);
  assert.equal(requests, 4);
  assert.match((await preview({...login, ca: cert + key}, 400)).error, /公开证书/);

  // Simulate macOS trusting this certificate without modifying the machine's trust store.
  if (process.platform === "darwin") {
    const execFile = childProcess.execFile;
    const fallbackRequests = [];
    t.mock.method(childProcess, "execFile", (command, args, options, callback) => {
      if (command !== "/usr/bin/curl") return execFile(command, args, options, callback);
      const stdin = new PassThrough();
      let input = "";
      stdin.setEncoding("utf8").on("data", chunk => { input += chunk; });
      stdin.once("end", () => {
        const settings = input.trimEnd().split("\n").map(line => JSON.parse(line.slice(line.indexOf(" = ") + 3)));
        const [url, method, ...headers] = settings;
        fallbackRequests.push({url, method, headers, args, env: options.env});
        const value = new URL(url).pathname === "/api/v1/users/profile/" ? {id: f.user, username: "alice"} : [];
        callback(null, Buffer.from(JSON.stringify(value) + "\n200"));
      });
      return {stdin};
    });
    assert.equal((await preview(login, 200)).userId, f.user);
    assert.equal(requests, 4);
    assert.deepEqual(fallbackRequests.map(call => new URL(call.url).pathname), ["/api/v1/users/profile/", "/api/v1/perms/users/self/nodes/"]);
    for (const call of fallbackRequests) {
      assert.equal(new URL(call.url).origin, login.origin);
      assert.equal(call.method, "GET");
      assert.ok(call.headers.includes("Authorization: Bearer " + f.login.secret));
      assert.equal(call.args[0], "-q");
      assert.deepEqual(call.args.slice(call.args.indexOf("--proto"), call.args.indexOf("--proto") + 2), ["--proto", "=https"]);
      assert.deepEqual(call.args.slice(-2), ["--config", "-"]);
      assert.ok(!call.args.some(arg => ["-k", "--insecure", "-L", "--location"].includes(arg)));
      assert.ok(!JSON.stringify([call.args, call.env]).includes(f.login.secret));
    }
  }
});

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

test("an authenticated endpoint edit keeps the binding, credentials and resource references", async t => {
  const f = await fixture(t);
  const binding = await f.bind();
  const [resource] = f.resources();
  const oldRevision = f.app.execution.revision(resource);
  const input = {kokoHost:"127.0.0.1",kokoPort:31222,expectedRevision:binding.revision};
  await f.api(f.base,"PATCH",{...input,kokoPort:0},400);
  await f.api(f.base,"PATCH",{...input,expectedRevision:binding.revision + 1},409);

  f.state.denied = true;
  const updated = await f.api(f.base,"PATCH",input);
  assert.equal(updated.id,binding.id);
  assert.equal(updated.kokoPort,input.kokoPort);
  assert.equal(updated.revision,binding.revision + 1);
  assert.equal(updated.lastSync,binding.lastSync);
  assert.equal(updated.assetCount,binding.assetCount);
  assert.equal(f.resources()[0].id,resource.id);
  assert.notEqual(f.app.execution.revision(f.resources()[0]),oldRevision);
  await f.api(f.base,"PATCH",input,409);

  f.state.denied = false;
  const synced = await f.api(f.base+"/sync","POST",{});
  assert.equal(synced.kokoPort,input.kokoPort);
  assert.equal(synced.state,"ready");
});

test("two personal mounts namespace the same asset and a session may only use its project's reference",async t=>{
  const f=await fixture(t);
  const first=await f.bind();
  const firstResource=f.resources()[0];
  const secondProject=f.app.store.createProject("第二项目");
  f.state.user=randomUUID();f.state.username="bob";
  const secondPath="/api/projects/"+secondProject.id+"/jumpserver";
  const second=await f.api(secondPath,"PUT",{...f.login,userId:f.state.user,expectedRevision:0,nodeId:null,kokoHost:"127.0.0.1",kokoPort:2222});
  assert.notEqual(first.userId,second.userId);
  const secondResource=f.resources().find(r=>r.projectId===secondProject.id);
  assert.equal(firstResource.jumpServer.assetId,secondResource.jumpServer.assetId);
  assert.notEqual(firstResource.id,secondResource.id);
  const session=f.app.store.createSession(secondProject.id);
  await assert.rejects(f.app.execution.ssh.connect(session.id,firstResource,new AbortController().signal),/不在本项目/);
  await f.api(f.base+"/sync","POST",{},403);
  assert.deepEqual(f.resources().map(r=>r.id),[secondResource.id]);
  assert.equal(f.state.tickets.length,0);
});

test("personal Access Key signs paged paths, account ambiguity and invalid tickets stop before SSH",async t=>{
  const f=await fixture(t);
  f.state.assets.push({...f.target,id:randomUUID(),name:"只读目录项"});
  await f.bind({authMethod:"accessKey",keyId:f.state.keyId});
  const r=f.resources().find(item=>item.kind==="ssh");
  assert.ok(f.resources().some(item=>item.kind==="jumpserver"));
  const path="/api/resources/"+r.id+"/jumpserver-accounts";
  f.state.accounts.push({...f.state.accounts[0],id:randomUUID(),alias:"developer"});
  const ssh=f.app.execution.ssh, session=f.app.store.createSession(f.project.id);
  const connect=()=>ssh.connect(session.id,r,new AbortController().signal);
  await assert.rejects(connect(),/选择当前授权账号/);
  assert.equal(f.state.tickets.length,0);
  await f.api(path,"PUT",{accountId:f.account});
  const current=f.resources().find(item=>item.id===r.id);
  const chosen=()=>ssh.connect(session.id,current,new AbortController().signal);
  f.state.ticketFields={asset:randomUUID()};
  await assert.rejects(chosen(),/连接身份/);
  f.state.ticketFields={is_reusable:true};
  await assert.rejects(chosen(),/连接未获准/);
  f.state.accounts[0].date_expired="2020/08/01 10:00:00 +0800";
  await assert.rejects(chosen(),/选择当前授权账号/);
  assert.equal(f.state.tickets.length,2);
  const oldTree=f.app.store.catalog().resourceTree.filter(n=>n.bindingId).length;
  f.state.nodes=[{value:"缺少身份的节点"}];
  await f.api(f.base+"/sync","POST",{},502);
  assert.equal(f.app.store.catalog().resourceTree.filter(n=>n.bindingId).length,oldTree);
});

async function eventually(read, predicate) {
  const until=Date.now()+5000;
  while(Date.now()<until){ const value=await read();if(predicate(value))return value;await new Promise(resolve=>setTimeout(resolve,35)); }
  throw Error("timed out waiting for test gateway");
}
test("KoKo native shell and specialist exec use separate channels, audited tokens and current authorization",async t=>{
  const f=await fixture(t);
  const {createRequire}=require("node:module");
  const {Server,utils}=createRequire(join(__dirname,"../../third_party/agent-sdk/package.json"))("ssh2");
  const clients=new Set(),used=new Set(),wire=[],inputs=[];
  let mode="normal";
  const gateway=new Server({hostKeys:[utils.generateKeyPairSync("ed25519").private]},client=>{
    clients.add(client);client.on("error",()=>{});client.once("close",()=>clients.delete(client));
    client.on("authentication",ctx=>{
      const row=f.state.tickets.find(({ticket})=>ctx.username==="JMS-"+ticket.id && ticket.value===ctx.password && !used.has(ticket.id));
      if(ctx.method!=="password"||!row)return ctx.reject(["password"]);
      used.add(row.ticket.id);ctx.accept();
    }).on("ready",()=>client.on("session",accept=>{
      const session=accept();
      session.on("pty",accept=>accept()).on("window-change",accept=>accept?.());
      session.on("shell",accept=>{wire.push("shell");const channel=accept();channel.write("authorized terminal\r\n");
        channel.on("data",data=>{inputs.push(data.toString());channel.write("ordinary-user\r\n");});});
      session.on("exec",(accept,_reject,info)=>{wire.push(info.command);const channel=accept();
        if(mode==="normal")channel.write("ordinary-user\n");
        if(mode==="review")channel.write("SSH Command not support ACL review ticket");
        channel.exit(0);channel.end();});
    }));
  });
  await new Promise(resolve=>gateway.listen(0,"127.0.0.1",resolve));
  t.after(async()=>{for(const c of clients)c.end();await new Promise(resolve=>gateway.close(resolve));});
  await f.bind({kokoPort:gateway.address().port});
  const [r]=f.resources(), ctx=await f.api("/api/resources/"+r.id+"/terminal-context","POST",{});
  const base="/api/sessions/"+ctx.sessionId+"/terminals", terminal=await f.api(base,"POST",{resourceId:r.id},201);
  const path=base+"/"+terminal.id, history=()=>f.api(path+"/history");
  const ready=await eventually(history,h=>h.terminal.status==="ready");
  assert.equal(ready.terminal.jumpServerAudit.assetId,f.asset);
  await f.api(path+"/input","POST",{data:"whoami\r"},202);
  await eventually(history,h=>h.output.includes("ordinary-user"));
  assert.equal(inputs.join(""),"whoami\r");
  assert.deepEqual(wire,["shell"]);
  const execution=f.app.execution, session=f.app.store.createSession(f.project.id);
  const actor={sessionId:session.id,taskId:randomUUID(),workerId:randomUUID(),generation:1,guard:()=>{}};
  const run=(command,callId=randomUUID())=>{
    const plan=execution.plan(f.project.id,{command,asset_ref:r.id,configuration_revision:execution.revision(r)});
    return execution.bind({},actor,plan,callId).run({command:{},timeoutMs:5000});
  };
  const result=await run("whoami");
  assert.equal(result.status,"completed");assert.equal(result.stdout.text,"ordinary-user\n");assert.equal(wire.at(-1),"whoami");
  const audit=f.app.store.list("commandExecutions").at(-1).jumpServerAudit;
  assert.equal(audit.assetId,f.asset);assert.equal(audit.accountId,f.account);
  assert.ok(used.has(audit.connectionTokenId));assert.equal(used.size,2);
  const metric=await execution.ssh.inspect(session.id,r,"disks",new AbortController().signal,()=>{});
  assert.equal(metric.jumpServerAudit.assetId,f.asset);assert.equal(metric.hostFingerprint,undefined);
  mode="review";const blocked=await run("whoami");assert.notEqual(blocked.status,"completed");assert.match(blocked.stderr.text,/复核/);
  mode="silent";await assert.rejects(run("whoami"),/未返回可核实/);
  assert.ok(f.app.store.list("commandExecutions").some(record=>record.status==="unknown"));
  const oldCount=wire.length;f.state.accounts=[];await f.api(f.base+"/sync","POST",{});
  await eventually(history,h=>h.terminal.status==="disconnected");
  const denied=await run("whoami");assert.notEqual(denied.status,"completed");assert.equal(wire.length,oldCount);
  for(const {ticket} of f.state.tickets)assert.ok(!JSON.stringify(f.app.store.list("commandExecutions")).includes(ticket.value));
});
