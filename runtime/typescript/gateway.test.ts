import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {writeFileSync,chmodSync,mkdirSync,symlinkSync,renameSync,unlinkSync} from 'node:fs';
import {HttpError} from './store';
import {LakeGateway} from './gateway';

const differentToken=(token:string)=>token.slice(0,-1)+(token.endsWith('0')?'1':'0');

async function fixture(t:{after(fn:()=>Promise<void>):void},denied=false){
 const home=await mkdtemp(join(tmpdir(),'lake-gateway-')),secrets=join(home,'secrets');
 mkdirSync(secrets,{recursive:true,mode:0o700});chmodSync(secrets,0o700);
 const security={check:()=>{if(denied)throw new HttpError(403,'denied');}};
 const gateway=new LakeGateway(home,security);
 t.after(async()=>{gateway.close();await rm(home,{recursive:true,force:true});});
 return {home,gateway,secrets};
}

test('gateway tokens are created once, listed without plaintext and removed permanently',async t=>{
 const f=await fixture(t);
 const created=f.gateway.create({name:'研发 Claude Code',roles:['role_dba']});
 assert.match(created.token,/^lkgw_[0-9a-f]{48}$/);assert.equal(created.roles![0],'role_dba');
 const listed=f.gateway.list().tokens;
 assert.equal(listed.length,1);assert.equal(listed[0].name,'研发 Claude Code');assert.equal(JSON.stringify(listed).includes(created.token),false,'plaintext never appears in views');
 f.gateway.remove(created.id);
 assert.equal(f.gateway.list().tokens.length,0);
 assert.throws(()=>f.gateway.remove(created.id),/不存在/);
 const second=f.gateway.create({name:'另一个'});
 assert.notEqual(second.token,created.token,'each token is independently random');
});

test('authenticate only accepts the exact token and enforces scoped roles',async t=>{
 const f=await fixture(t);
 const scoped=f.gateway.create({name:'dba-only',roles:['role_dba']}),wide=f.gateway.create({name:'all'});
 const auth=f.gateway.authenticate(scoped.token);
 assert.deepEqual(auth,{id:scoped.id,roles:['role_dba']});
 assert.deepEqual(f.gateway.authenticate(wide.token),{id:wide.id});
 for(const attempt of [differentToken(scoped.token),'Bearer '+scoped.token,'','lk_gw_wrong'])
  assert.throws(()=>f.gateway.authenticate(attempt),/需要 Lake 网关凭据/);
 f.gateway.requireRole(auth,'role_dba');
 assert.throws(()=>f.gateway.requireRole(auth,'role_sre'),/未被允许访问该专员/);
 f.gateway.requireRole(f.gateway.authenticate(wide.token),'role_sre');
});

test('negative token candidates differ for every possible final hex digit',async t=>{
 const f=await fixture(t);
 for(const last of '0123456789abcdef'){
  const token='synthetic-token-'+last;
  writeFileSync(join(f.secrets,'mcp-gateway.json'),JSON.stringify({version:1,tokens:[{id:'edge',name:'edge',token,createdAt:'2026-11-15'}]}),{mode:0o600});
  assert.equal(f.gateway.authenticate(token).id,'edge');
  assert.notEqual(differentToken(token),token);
  assert.throws(()=>f.gateway.authenticate(differentToken(token)),/需要 Lake 网关凭据/);
 }
});

test('a tampered or world-readable credentials file is rejected',async t=>{
 const f=await fixture(t);
 const created=f.gateway.create({name:'safe'});
 // World-readable token file must not authenticate.
 chmodSync(join(f.secrets,'mcp-gateway.json'),0o644);
 assert.throws(()=>f.gateway.authenticate(created.token),/私有文件/);
 chmodSync(join(f.secrets,'mcp-gateway.json'),0o600);
 // A symlinked file is equally rejected.
 chmodSync(join(f.secrets,'mcp-gateway.json'),0o600);
 const outside=join(f.home,'outside.json');writeFileSync(outside,'{"version":1,"tokens":[]}');
 renameSync(join(f.secrets,'mcp-gateway.json'),join(f.secrets,'real.json'));
 symlinkSync(outside,join(f.secrets,'mcp-gateway.json'));
 assert.throws(()=>f.gateway.authenticate(created.token),/私有文件/);
 // Broken JSON fails closed instead of authenticating anyone.
 unlinkSync(join(f.secrets,'mcp-gateway.json'));writeFileSync(join(f.secrets,'mcp-gateway.json'),'{broken');chmodSync(join(f.secrets,'mcp-gateway.json'),0o600);
 assert.throws(()=>f.gateway.authenticate('lkgw_anything'),/格式无效/);
});

test('creation and deletion respect the security fence and input validation',async t=>{
 const f=await fixture(t,true);
 assert.throws(()=>f.gateway.create({name:'blocked'}),/denied/);
 const gateway=new LakeGateway(f.home,undefined);
 assert.throws(()=>gateway.create({name:''}),/name/);
 assert.throws(()=>gateway.create({name:'x',roles:['not ok!']}),/专员身份无效/);
 assert.throws(()=>gateway.create({name:'x',roles:[]}),/非空身份列表/);
 assert.throws(()=>gateway.create({unexpected:1,name:'x'}),/字段无效/);
 assert.throws(()=>gateway.remove('missing'),/不存在/);
 // Same name conflicts instead of silently creating a second credential.
 const first=gateway.create({name:'dup'});
 assert.throws(()=>gateway.create({name:'dup'}),/同名/);
 assert.ok(first.token);
});

test('project connections persist without exposing credentials and keep legacy scopes separate',async t=>{
 const f=await fixture(t),legacy=f.gateway.create({name:'legacy',roles:['role_dba']});
 const connection=f.gateway.createConnection({name:'我的 Codex',projectId:'project_a'});
 assert.deepEqual(connection.routing,{mode:'pilot'});assert.equal(connection.enabled,true);
 assert.equal('token' in connection,false);
 const local=f.gateway.resolveToken(connection.id),auth=f.gateway.authenticate(local.token);
 assert.equal(auth.connection?.projectId,'project_a');
 assert.deepEqual(f.gateway.list().tokens.map(row=>row.id),[legacy.id]);
 assert.equal(JSON.stringify(f.gateway.connections()).includes(local.token),false);
 assert.throws(()=>f.gateway.requireRole(auth,'role_dba'),/只能使用消息/);
 assert.throws(()=>f.gateway.requireConnection(f.gateway.authenticate(legacy.token)),/原专员入口/);
 const restarted=new LakeGateway(f.home);
 assert.deepEqual(restarted.connection(connection.id),connection);
 assert.equal(restarted.authenticate(local.token).id,connection.id);
});

test('connection changes revoke stale revisions and disabled or deleted connections fail closed',async t=>{
 const f=await fixture(t),connection=f.gateway.createConnection({name:'Codex',projectId:'project_a'});
 const secret=f.gateway.resolveToken(connection.id).token;
 const disabled=f.gateway.updateConnection(connection.id,{enabled:false,expectedUpdatedAt:connection.updatedAt});
 assert.notEqual(disabled.updatedAt,connection.updatedAt);
 assert.throws(()=>f.gateway.authenticate(secret),/已停用/);
 assert.throws(()=>f.gateway.updateConnection(connection.id,{name:'stale',expectedUpdatedAt:connection.updatedAt}),/已变化/);
 const enabled=f.gateway.updateConnection(connection.id,{enabled:true,routing:{mode:'specialist',roleId:'role_dba'},expectedUpdatedAt:disabled.updatedAt});
 assert.equal(enabled.enabled,true);assert.equal(f.gateway.authenticate(secret).connection?.routing.mode,'specialist');
 assert.throws(()=>f.gateway.updateConnection(connection.id,{projectId:'project_b'}),/字段无效/);
 f.gateway.removeConnection(connection.id);
 assert.throws(()=>f.gateway.authenticate(secret),/需要 Lake 网关凭据/);
 assert.throws(()=>f.gateway.connection(connection.id),/不存在/);
});

test('connection writes validate scope shape and obey the security fence',async t=>{
 const f=await fixture(t);
 for(const input of [
  {name:'x',projectId:''}, {name:'x',projectId:'p',roles:['role']},
  {name:'x',projectId:'p',routing:{mode:'pilot',roleId:'role'}},
  {name:'x',projectId:'p',routing:{mode:'specialist'}},
  {name:'x',projectId:'p',routing:{mode:'other'}},
 ]) assert.throws(()=>f.gateway.createConnection(input));
 const created=f.gateway.createConnection({name:'valid',projectId:'p'});
 assert.throws(()=>f.gateway.updateConnection(created.id,{enabled:'false'}),/布尔/);
 const denied=new LakeGateway(f.home,{check(){throw new HttpError(403,'denied');}});
 assert.throws(()=>denied.createConnection({name:'denied',projectId:'p'}),/denied/);
 assert.throws(()=>denied.updateConnection(created.id,{enabled:false}),/denied/);
 assert.throws(()=>denied.removeConnection(created.id),/denied/);
});

test('malformed persisted connection records cannot become broad legacy credentials',async t=>{
 const f=await fixture(t),connection=f.gateway.createConnection({name:'valid',projectId:'p'});
 const token=f.gateway.resolveToken(connection.id).token;
 writeFileSync(join(f.secrets,'mcp-gateway.json'),JSON.stringify({version:1,tokens:[{id:connection.id,name:'tampered',token,createdAt:connection.createdAt,
  roles:['role_dba'],connection:{projectId:'p',enabled:true,routing:{mode:'pilot'},updatedAt:connection.updatedAt}}]}),{mode:0o600});
 assert.throws(()=>f.gateway.authenticate(token),/接入连接记录无效/);
});
