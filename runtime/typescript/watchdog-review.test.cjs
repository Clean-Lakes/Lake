const {test} = require("node:test");
const assert = require("node:assert/strict");
const {createServer} = require("node:http");
const {mkdtemp, mkdir, rm} = require("node:fs/promises");
const {tmpdir} = require("node:os");
const {join} = require("node:path");
process.env.LAKE_TS_IMPORT_ONLY = "1";
const {startLakeServer} = require("../../bin/lake-runtime/server.cjs");

test("watchdog reviews run in a clean, bounded model context and cancel the actual HTTP request", {timeout:15_000}, async t => {
  const requests = [];
  let onRequest, onDisconnect;
  let reply = () => ({verdict:"drift", reason:"只检查了缓存。test-credential-for-local-review"});
  const provider = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString()));
    onRequest?.();
    res.once("close", () => onDisconnect?.());
    if (reply) {
      res.writeHead(200, {"Content-Type":"application/json"});
      res.end(JSON.stringify({id:"watchdog-fixture",object:"chat.completion",created:1,model:"watchdog-fixture",
        choices:[{index:0, message:{role:"assistant",content:JSON.stringify(reply())},finish_reason:"stop"}],
        usage:{prompt_tokens:8,completion_tokens:4,total_tokens:12}}));
    }
  });
  await new Promise(resolve => provider.listen(0, "127.0.0.1", resolve));
  t.after(() => { provider.closeAllConnections(); return new Promise(resolve => provider.close(resolve)); });
  const home = await mkdtemp(join(tmpdir(),"lake-watchdog-review-"));
  const staticRoot = join(home,"web");
  await mkdir(staticRoot);
  const app = await startLakeServer({home,data:join(home,"data"),staticRoot,port:0});
  t.after(async () => { await app.close(); await rm(home,{recursive:true,force:true}); });
  const api = async (path, method, data) => {
    const response = await fetch(app.origin+path, {method, headers:{Authorization:"Bearer "+app.token,"Content-Type":"application/json"},body:JSON.stringify(data)});
    assert.equal(response.status, 200);
    return response.json();
  };
  await api("/api/settings/model","PUT",{url:"http://127.0.0.1:"+provider.address().port+"/v1/chat/completions",name:"watchdog-fixture",apiKey:"test-credential-for-local-review"});
  const project = await api("/api/projects","POST",{name:"巡检隔离项目"});
  const other = await api("/api/projects","POST",{name:"另一个项目"});
  const session = await api("/api/projects/"+project.id+"/sessions","POST",{});
  app.store.addMessage(session.id,"user","PRIVATE TRANSCRIPT");
  const input = {projectId:project.id,sessionId:session.id,goal:"查数据库 test-credential-for-local-review",
    assignment:"检查连接", observations:["TOP OF HISTORY",...Array(6).fill("重复操作"), "password='inline fixture value'", "X".repeat(350)],
    unrelated:"RAW TOOL OUTPUT"};
  const review = (value=input, signal=new AbortController().signal) => app.agents.reviewWatchdog(value,signal);
  await assert.rejects(review({...input,projectId:other.id}), /不属于/);
  assert.equal(requests.length,0);
  assert.deepEqual(await review(), {verdict:"drift",reason:"只检查了缓存。[REDACTED]"});
  const request = requests[0];
  assert.deepEqual(request.messages.map(m=>m.role),["system","user"]);
  assert.deepEqual(request.tools ?? [], []);
  assert.ok((request.max_tokens ?? request.max_completion_tokens) <= 768);
  const data = JSON.parse(request.messages[1].content);
  assert.deepEqual(Object.keys(data).sort(),["assignment","goal","observations"]);
  assert.equal(data.observations.length,8);
  assert.equal(data.observations.at(-1).length,200);
  assert.doesNotMatch(JSON.stringify(request),/PRIVATE TRANSCRIPT|RAW TOOL OUTPUT|TOP OF HISTORY|test-credential-for-local-review|inline fixture value/);
  reply = () => ({verdict:"drift", reason:"unchecked",command:"run this"});
  await assert.rejects(review(),/有效判断/);
  assert.deepEqual(app.store.messages(session.id).map(m=>m.text),["PRIVATE TRANSCRIPT"]);

  reply = undefined;
  const controller = new AbortController();
  const started = new Promise(resolve=>{onRequest=resolve;});
  const disconnected = new Promise(resolve=>{onDisconnect=resolve;});
  const pending = review(input,controller.signal);
  await started;
  controller.abort();
  await assert.rejects(pending,{name:"AbortError"});
  await disconnected;
  assert.equal(requests.length,3);
  assert.equal(app.store.list("superOperations").length,0);
  assert.equal(app.store.list("superAcceptance").length,0);
});
