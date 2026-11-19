const test = require('node:test');
const assert = require('node:assert/strict');
const {createServer} = require('node:http');
const {chmod,mkdtemp,mkdir,realpath,rm,writeFile} = require('node:fs/promises');
const {DatabaseSync} = require('node:sqlite');
const {tmpdir} = require('node:os');
const {join} = require('node:path');
process.env.LAKE_TS_IMPORT_ONLY = '1';
const {startLakeServer} = require('../../bin/lake-runtime/server.cjs');

const credential = 'synthetic-grafana-service-account';
const writeCredential = 'synthetic-grafana-editor';
const catalog = [{uid:'metrics',name:'Prometheus',type:'prometheus'}, {uid:'logs',name:'Loki',type:'loki'}, {uid:'sql',name:'SQL',type:'postgres'}];
const scope = {start:1720000000000,end:1720003600000};

async function fixture(t, grafanaReceiverBase) {
  const home = await mkdtemp(join(tmpdir(),'grafana-api-'));
  const web = join(home,'static');
  await mkdir(web);
  await writeFile(join(web,'index.html'),'<html>Grafana fixture</html>');
  const requests = [];
  const points = new Map();
  const transport = {loseWriteResponse: false, denyWrite: false, callback: true};
  const upstream = createServer(async (request,response) => {
    const url = new URL(request.url,'http://fixture');
    requests.push({method:request.method,path:url.pathname,query:url.searchParams});
    const reply = (value, status = 200) => {
      response.writeHead(status, {'Content-Type':'application/json'});
      response.end(JSON.stringify(value));
    };
    const bearer = request.headers.authorization?.replace(/^Bearer /,'');
    if (![credential,writeCredential].includes(bearer)) return reply({},401);
    const contactPath = '/grafana/api/v1/provisioning/contact-points';
    if (url.pathname === contactPath || url.pathname.startsWith(contactPath+'/')) {
      if (bearer === credential) return reply({},403);
      if (request.method === 'GET')
        return reply([...points.values()].map(point=>({...point,settings:{...point.settings,authorization_credentials:'[REDACTED]'}})));
      if (transport.denyWrite) return reply({},403);
      const body = [];
      for await (const chunk of request) body.push(chunk);
      const point = JSON.parse(Buffer.concat(body).toString());
      if (request.method === 'POST' && (url.pathname !== contactPath || points.has(point.uid)) ||
          request.method === 'PUT' && (url.pathname !== contactPath+'/'+point.uid || !points.has(point.uid)))
        return reply({},409);
      points.set(point.uid,point);
      if (transport.loseWriteResponse) {
        transport.loseWriteResponse = false;
        return response.destroy();
      }
      return reply({},202);
    }
    switch (url.pathname) {
      case '/grafana/api/alertmanager/grafana/config/api/v1/receivers/test': {
        if (!transport.callback) return reply({});
        if (bearer !== writeCredential) return reply({},403);
        const body = [];
        for await (const chunk of request) body.push(chunk);
        const probe = JSON.parse(Buffer.concat(body).toString()).receivers[0].grafana_managed_receiver_configs[0];
        const callback = await fetch(probe.settings.url, {method: 'POST', headers: {
          Authorization: 'Bearer '+probe.secureSettings.authorization_credentials,
        }});
        await callback.body?.cancel();
        return reply({}, callback.ok ? 200 : 400);
      }
      case '/grafana/api/org': return reply({id:1,name:'Lake read test'});
      case '/grafana/api/search': return reply([{uid:'ops',title:'Operations'}]);
      case '/grafana/api/dashboards/uid/ops': return reply({dashboard:{uid:'ops',title:'Operations',panels:[]}});
      case '/grafana/api/datasources': return reply(catalog.map(item=>({...item,url:'http://private-datasource',secureJsonData:{ignored:credential}})));
      case '/grafana/api/prometheus/grafana/api/v1/rules': return reply({status:'success',data:{groups:[]}});
      case '/grafana/api/alertmanager/grafana/api/v2/alerts': return reply([{labels:{alertname:'GrafanaActive'}}]);
      case '/grafana/api/datasources/uid/metrics': return reply(catalog[0]);
      case '/grafana/api/datasources/uid/logs': return reply(catalog[1]);
      case '/grafana/api/datasources/uid/sql': return reply(catalog[2]);
      case '/grafana/api/datasources/proxy/uid/metrics/api/v1/query_range':
        return reply({status:'success',data:{result:[{values:[[1720000000,'7']]}]}});
      case '/grafana/api/datasources/proxy/uid/logs/loki/api/v1/query_range':
        return reply({status:'success',data:{result:[{values:[['1720000000000000000','log with '+credential]]}]}});
      case '/redirect/api/org':
        response.writeHead(302,{Location:'/credential-canary'});
        return response.end();
      default: return reply({},404);
    }
  });
  await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve));
  const endpoint = 'http://127.0.0.1:' + upstream.address().port;
  const options = {home,data:join(home,'data'),staticRoot:web,port:0,grafanaReceiverBase};
  let app = await startLakeServer(options);
  const restart = async () => {
    await app.close();
    app = await startLakeServer(options);
  };
  t.after(async () => {
    await app.close();
    await new Promise(resolve=>upstream.close(resolve));
    await rm(home,{recursive:true,force:true});
  });
  const api = async (route,{method='GET',data,token=app.token,status=200}={}) => {
    const response = await fetch(app.origin+route,{method,headers:{
      ...(token?{Authorization:'Bearer '+token}:{}),
      ...(data===undefined?{}:{'Content-Type':'application/json'}),
    },...(data===undefined?{}:{body:JSON.stringify(data)})});
    assert.equal(response.status,status,method+' '+route);
    return response.json();
  };
  const project = await api('/api/projects',{method:'POST',data:{name:'Grafana operations'}});
  const base = '/api/projects/' + project.id + '/resources';
  const settings = {endpoint:endpoint+'/grafana',token:credential};
  const create = (config=settings) => api(base,{method:'POST',data:{kind:'grafana',name:'Grafana',settings:config}});
  const read = (resource,input,status=200) => api('/api/resources/'+resource.id+'/grafana-read',{
    method:'POST',status,data:{revision:resource.configurationRevision,...input},
  });
  return {api,get app() {return app},home,project,endpoint,requests,settings,base,create,read,points,transport,restart};
}

test('a Grafana resource reads its catalog, alerts and bounded data source observations', async t => {
  const f = await fixture(t);
  const probe = await f.api(f.base+'/test',{method:'POST',data:{kind:'grafana',settings:f.settings}});
  assert.match(probe.message,/仪表盘可读.*数据源可读.*告警规则可读.*活动告警可读/);
  const resource = await f.create();
  assert.ok(resource.settings.credentialRef);
  assert.ok(!JSON.stringify(resource).includes(credential));
  assert.equal((await f.read(resource,{operation:'folders'})).items[0].uid,'ops');
  assert.equal((await f.read(resource,{operation:'dashboards'})).items[0].title,'Operations');
  assert.equal((await f.read(resource,{operation:'dashboard',uid:'ops'})).data.dashboard.title,'Operations');
  assert.deepEqual((await f.read(resource,{operation:'datasources'})).items,catalog);
  assert.equal((await f.read(resource,{operation:'rules'})).data.status,'success');
  assert.equal((await f.read(resource,{operation:'alerts'})).data[0].labels.alertname,'GrafanaActive');
  assert.deepEqual((await f.read(resource,{operation:'metrics',datasourceUid:'metrics',expression:'up',...scope})).data.data.result[0].values,
    [[1720000000,'7']]);
  const logs = await f.read(resource,{operation:'logs',datasourceUid:'logs',expression:'{app="ops"}',...scope});
  assert.equal(logs.data.data.result[0].values[0][1],'log with [REDACTED]');
  assert.ok(f.requests.every(request=>request.method==='GET'));
  const logQuery = f.requests.find(request=>request.path.includes('/loki/api/v1/query_range')).query;
  assert.equal(logQuery.get('limit'),'200');
  assert.equal(logQuery.get('start'),'1720000000000000000');
});

test('Grafana credentials stay bound to the configured address and revisions', async t => {
  const f = await fixture(t);
  await f.api(f.base+'/test',{method:'POST',status:502,data:{kind:'grafana',settings:{...f.settings,endpoint:f.endpoint+'/redirect'}}});
  assert.ok(!f.requests.some(request=>request.path==='/credential-canary'));
  const resource = await f.create();
  const route = '/api/resources/'+resource.id;
  await f.api(route,{method:'PATCH',status:400,data:{settings:{endpoint:f.endpoint+'/redirect'}}});
  await f.api(route+'/grafana-read',{method:'POST',token:null,status:401,data:{operation:'datasources',revision:1}});
  const requested = f.requests.length;
  await f.read(resource,{operation:'datasources',revision:0},409);
  await f.read(resource,{operation:'dashboard',uid:'..'},400);
  await f.read(resource,{operation:'logs',datasourceUid:'logs',expression:'{app="ops"}',start:0,end:Date.now()},400);
  assert.equal(f.requests.length,requested);
  await f.read(resource,{operation:'metrics',datasourceUid:'sql',expression:'up',...scope},400);
  assert.ok(!f.requests.some(request=>request.path.includes('/proxy/uid/sql/')));
});

test('only an authenticated same-origin workbench can reveal the current saved Grafana token', async t => {
  const f = await fixture(t);
  const resource = await f.create();
  const receiverOnly = await f.create({});
  const otherResource = await f.api(f.base, {method:'POST', data:{kind:'local',name:'Other resource'}});
  await f.restart();

  const bootstrap = await fetch(f.app.origin + '/api/bootstrap', {
    headers:{Authorization:'Bearer ' + f.app.token},
  });
  assert.equal(bootstrap.status, 200);
  const cookie = bootstrap.headers.getSetCookie()[0].split(';')[0];
  await bootstrap.body.cancel();
  const headers = {Cookie:cookie, Origin:f.app.origin};
  const version = {revision:resource.configurationRevision};
  const reveal = (input = version, auth = headers, id = resource.id) =>
    fetch(f.app.origin + '/api/resources/' + id + '/grafana-token', {
      method:'POST',
      headers:{...auth, 'Content-Type':'application/json'},
      body:JSON.stringify(input),
    });
  const expectDenied = async (status, response) => {
    assert.equal(response.status, status);
    assert.ok(!(await response.text()).includes(credential));
  };

  await expectDenied(401, await reveal(version, {}));
  await expectDenied(403, await reveal(version, {Authorization:'Bearer ' + f.app.token, Origin:f.app.origin}));
  await expectDenied(403, await reveal(version, {Cookie:cookie}));
  await expectDenied(403, await reveal(version, {...headers, Origin:'https://example.test'}));
  await expectDenied(400, await reveal({}));
  await expectDenied(404, await reveal({revision:otherResource.configurationRevision}, headers, otherResource.id));
  await expectDenied(409, await reveal({revision:receiverOnly.configurationRevision}, headers, receiverOnly.id));

  const current = await reveal();
  assert.equal(current.status, 200);
  assert.equal(current.headers.get('Cache-Control'), 'no-store');
  assert.ok((await current.json()).token === credential);
  const url = '/api/resources/' + resource.id;
  assert.ok(!JSON.stringify(await f.api(url)).includes(credential));

  const rotated = await f.api(url, {method:'PATCH',data:{settings:{token:writeCredential}}});
  await expectDenied(409, await reveal());
  const afterRotation = await reveal({revision:rotated.configurationRevision});
  assert.equal(afterRotation.status, 200);
  assert.ok((await afterRotation.json()).token === writeCredential);
  assert.equal(f.requests.length, 0);
});

test('adding API configuration to an existing Grafana receiver preserves its ingress identity', async t => {
  const f = await fixture(t);
  const original = await f.create({});
  const route = '/api/resources/'+original.id;
  const webhook = await f.api(route+'/grafana-webhook',{method:'POST',data:{},status:201});
  await f.read(original,{operation:'datasources'},409);
  const configured = await f.api(route,{method:'PATCH',data:{settings:f.settings}});
  assert.equal(configured.id,original.id);
  assert.equal((await f.api(route+'/grafana-webhook')).source.webhookUrl,webhook.source.webhookUrl);
  assert.equal((await f.read(configured,{operation:'datasources'})).items.length,3);
  const webhookUrl = new URL(webhook.source.webhookUrl);
  await f.api(webhookUrl.pathname,{method:'POST',token:webhook.token,data:{
    version:'1',status:'firing',alerts:[{status:'firing',labels:{alertname:'KeepsReceiving'}}],
  }});
  assert.equal((await f.api('/api/settings/event-sources/'+original.id+'/deliveries')).deliveries.length,1);
});

test('Grafana reads follow a migrated host-managed catalog only while the exact original authority still matches', async t => {
  const f = await fixture(t), {store,services} = f.app;
  const projectId = f.project.id;
  const adk = join(store.data,'adk');
  await mkdir(adk,{recursive:true,mode:0o700});
  await mkdir(join(f.home,'security'),{recursive:true,mode:0o700});
  const storeID = 'a'.repeat(64), recoveryEpoch = 'b'.repeat(64);
  await writeFile(join(f.home,'security/control.json'),JSON.stringify({
    formatVersion:1,storeID,recoveryEpoch,gate:'open',storeReady:true,runtimeRoot:await realpath(adk),
  }),{mode:0o600});
  const dbPath = join(adk,'sessions.sqlite'), db = new DatabaseSync(dbPath);
  try {
    await chmod(dbPath,0o600);
    db.exec(`
      CREATE TABLE security_schema_meta (id INTEGER, schema_version INTEGER,
        minimum_reader_version INTEGER, store_id TEXT, recovery_epoch TEXT, migration_state TEXT);
      CREATE TABLE security_project_policies (project_id TEXT PRIMARY KEY, revision INTEGER,
        store_id TEXT, recovery_epoch TEXT, mode TEXT, confirmed INTEGER, data TEXT);
      CREATE TABLE security_authority_events (project_id TEXT, object_id TEXT, kind TEXT, actor_id TEXT,
        action_id TEXT, store_id TEXT, recovery_epoch TEXT, before_revision INTEGER, after_revision INTEGER, result TEXT);
    `);
    db.prepare("INSERT INTO security_schema_meta VALUES(1,1,3,?,?,'ready')").run(storeID,recoveryEpoch);
    const policy = {
      SchemaVersion:1,Confirmed:true,ProjectID:projectId,Mode:'legacy',Revision:1,StoreID:storeID,RecoveryEpoch:recoveryEpoch,
      ResourceIDs:store.catalog().resources.filter(resource=>resource.projectId===projectId).map(resource=>resource.id),
      Rules:['resource.manage','resource.resolve','network.fetch'].map(Capability=>({Capability,Effect:'allow'})),
    };
    const archived = {projectId,revision:1,mode:'legacy',readOnly:true,data:policy};
    store.put('legacyProjectPolicies',projectId,archived);
    db.prepare("INSERT INTO security_project_policies VALUES(?,1,?,?,'legacy',1,?)")
      .run(projectId,storeID,recoveryEpoch,JSON.stringify(policy));
    db.prepare("INSERT INTO security_authority_events VALUES(?,?,'policy.put','host',?,?,?,0,1,?)")
      .run(projectId,projectId,`superagent-catalog:${projectId}:1`,storeID,recoveryEpoch,JSON.stringify(policy));

    const resource = await f.create();
    assert.ok(!policy.ResourceIDs.includes(resource.id));
    const read = () => services.readGrafana(projectId,resource.id,resource.configurationRevision,
      {operation:'dashboards'},undefined,()=>services.security.network(projectId,f.settings.endpoint,resource.id));
    assert.equal((await read()).items[0].uid,'ops');
    assert.deepEqual(store.get('legacyProjectPolicies',projectId),archived);
    assert.throws(()=>services.security.network(projectId,f.endpoint+'/redirect',resource.id),/原项目策略未授权此资源/);

    const count = f.requests.length;
    db.prepare("UPDATE security_authority_events SET actor_id='local-user'").run();
    await assert.rejects(read(),{status:403,message:'原项目策略未授权此资源'});
    db.prepare("UPDATE security_authority_events SET actor_id='host'").run();
    db.prepare("UPDATE security_project_policies SET revision=2, data=?")
      .run(JSON.stringify({...policy,Revision:2}));
    await assert.rejects(read(),{status:403,message:'原项目策略未授权此资源'});
    assert.equal(f.requests.length,count,'a stale or manually managed policy cannot dispatch a read');
  } finally {
    db.close();
  }
});

test('automatic Grafana injection verifies a dedicated receiver and restores its exact address after restart', async t => {
  const f = await fixture(t);
  const resource = await f.create({...f.settings,token:writeCredential});
  const route = '/api/resources/'+resource.id+'/grafana-webhook';
  const inject = (status=200) => f.api(route+'/inject',{method:'POST',status,data:{revision:resource.configurationRevision}});
  f.transport.callback = false;
  assert.match((await inject(409)).error,/测试通知未到达/);
  assert.equal((await f.api(route)).source,null);
  assert.equal(f.points.size,0);

  f.transport.callback = true;
  f.transport.loseWriteResponse = true;
  await inject(502);
  const point = [...f.points.values()][0];
  const published = new URL(point.settings.url);
  assert.equal(published.hostname,'127.0.0.1');
  assert.notEqual(published.port,new URL(f.app.origin).port);
  assert.equal(published.pathname,'/api/ingress/v1/grafana/'+resource.id);
  assert.equal((await f.api(route)).source.contactPoint,undefined);
  const deliver = async token => fetch(published, {method:'POST',headers:{
    Authorization:'Bearer '+token,'Content-Type':'application/json',
  },body:JSON.stringify({version:'1',status:'resolved',alerts:[{status:'resolved'}]})});

  await f.restart();
  const unrelatedApi = await fetch(published.origin+'/api/bootstrap',{headers:{Authorization:'Bearer '+f.app.token}});
  assert.equal(unrelatedApi.status,404);
  await unrelatedApi.body?.cancel();
  const unauthorized = await deliver('not-a-webhook-credential');
  assert.equal(unauthorized.status,401);
  await unauthorized.body?.cancel();
  const afterLostResponse = await deliver(point.settings.authorization_credentials);
  assert.equal(afterLostResponse.status,200);
  assert.ok((await afterLostResponse.json()).id);

  const result = (await inject()).source;
  assert.equal(result.contactPoint.uid,point.uid);
  assert.equal(result.contactPoint.receiverBase,published.origin);
  assert.equal(result.contactPoint.localReceiver,true);
  assert.equal(result.localReceiverReady,true);
  await f.restart();
  assert.equal((await f.api(route)).source.localReceiverReady,true);
  const afterRestart = await deliver(point.settings.authorization_credentials);
  assert.equal(afterRestart.status,200);
  assert.ok((await afterRestart.json()).id);
  const inbox = await f.api('/api/settings/event-sources/'+resource.id+'/deliveries');
  assert.deepEqual(inbox.deliveries.map(delivery=>delivery.status),['resolved','resolved']);
  assert.equal(f.points.size,1);
});

test('one-click Grafana injection uses the saved connection, survives a lost reply and preserves the inbox', async t => {
  const receiverBase = 'https://lake.example.com/inbound';
  const f = await fixture(t,receiverBase+'/');
  const resource = await f.create();
  const resourceRoute = '/api/resources/'+resource.id;
  const route = resourceRoute+'/grafana-webhook';
  const manual = await f.api(route,{method:'POST',data:{},status:201});
  const ingress = new URL(manual.source.webhookUrl).pathname;
  const delivery = token => f.api(ingress,{method:'POST',token,data:{
    version:'1',status:'firing',alerts:[{status:'firing',labels:{alertname:'FixtureInjected'}}],
  }});
  await delivery(manual.token);
  const inject = (data,status=200) => f.api(route+'/inject',{method:'POST',data, status});
  const reader = {revision:resource.configurationRevision};
  await inject({...reader,token:writeCredential},400);
  await inject({...reader,receiverBase:'https://wrong.example.com'},400);
  assert.match((await inject(reader,403)).error,/缺少接入点读取权限/);
  const configured = await f.api(resourceRoute,{method:'PATCH',data:{settings:{token:writeCredential}}});
  const config = {revision:configured.configurationRevision};
  await inject(reader,409);
  f.transport.denyWrite = true;
  assert.match((await inject(config,403)).error,/缺少接入点写入权限/);
  f.transport.denyWrite = false;
  assert.equal(f.points.size,0);
  f.transport.loseWriteResponse = true;
  await inject(config,502);
  assert.equal(f.points.size,1);
  assert.equal((await f.api(route)).source.contactPoint,undefined);
  const first = [...f.points.values()][0];
  assert.match(first.name,/^Lake · Grafana · [a-f0-9]{8}$/);
  await delivery(first.settings.authorization_credentials);
  const renamed = await f.api(resourceRoute,{method:'PATCH',data:{name:'Renamed Lake resource'}});
  const updated = {revision:renamed.configurationRevision};
  const result = await inject(updated);
  assert.equal(result.source.contactPoint.uid,first.uid);
  const repeated = await inject(updated);
  const latest = f.points.get(first.uid);
  assert.equal(repeated.source.contactPoint.receiverBase,receiverBase);
  assert.equal(latest.settings.url,receiverBase+ingress);
  assert.equal(latest.settings.httpMethod,'POST');
  assert.equal(latest.settings.authorization_scheme,'Bearer');
  assert.equal(latest.settings.authorization_credentials,first.settings.authorization_credentials);
  assert.ok(!JSON.stringify(repeated).includes(writeCredential));
  assert.ok(!JSON.stringify(repeated).includes(first.settings.authorization_credentials));
  assert.equal(f.points.size,1);
  await delivery(manual.token);
  assert.equal((await f.api('/api/settings/event-sources/'+resource.id+'/deliveries')).deliveries.length,3);
  assert.equal(f.points.get(first.uid).name,first.name);
});
