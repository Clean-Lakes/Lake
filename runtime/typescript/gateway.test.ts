import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {writeFileSync,chmodSync,mkdirSync,symlinkSync,renameSync,unlinkSync} from 'node:fs';
import {HttpError} from './store';
import {LakeGateway} from './gateway';

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
 for(const attempt of [scoped.token.slice(0,-1)+'0','Bearer '+scoped.token,'','lk_gw_wrong'])
  assert.throws(()=>f.gateway.authenticate(attempt),/需要 Lake 网关凭据/);
 f.gateway.requireRole(auth,'role_dba');
 assert.throws(()=>f.gateway.requireRole(auth,'role_sre'),/未被允许访问该专员/);
 f.gateway.requireRole(f.gateway.authenticate(wide.token),'role_sre');
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
