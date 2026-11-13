import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {parse} from 'smol-toml';
import {CodexLocalSource,shellQuote} from './acp/codex-local';
import {codexStartupArgs} from './acp/codex-profile';
import {ExternalAgentRegistry} from './acp/registry';
import {LakeStore} from './store';

async function fixture(t:{after(fn:()=>Promise<void>):void}){
 const home=await mkdtemp(join(tmpdir(),'lake-codex-local-')),source=join(home,'codex');await mkdir(source);
 const config=join(source,'config.toml'),auth=join(source,'auth.json');
 await writeFile(config,'model = "gpt-6.1-sol"\nmodel_reasoning_effort = "max"\n');
 const token=(sub:string,nonce:string)=>'header.'+Buffer.from(JSON.stringify({sub,nonce})).toString('base64url')+'.signature';
 const login=async(account:string,nonce:string)=>writeFile(auth,JSON.stringify({auth_mode:'chatgpt',tokens:{account_id:'organization',id_token:token(account,nonce),access_token:'synthetic-access-'+nonce,refresh_token:'synthetic-refresh-'+nonce}}));
 await login('account-a','initial');const secrets=new Set<string>(),local=new CodexLocalSource(source,value=>secrets.add(value));
 t.after(()=>rm(home,{recursive:true,force:true}));return {home,source,config,auth,login,secrets,local};
}

test('local source registers secrets in memory and identifies accounts without invalidating token refresh',async t=>{
 const f=await fixture(t),initial=f.local.current();
 await f.login('account-a','refreshed');assert.equal(f.local.current().fingerprint,initial.fingerprint);
 await f.login('account-b','refreshed');assert.notEqual(f.local.current().fingerprint,initial.fingerprint);
 assert.ok(f.secrets.has('synthetic-access-refreshed'));assert.ok(f.secrets.has('synthetic-refresh-refreshed'));
 assert.ok(!JSON.stringify(initial).includes('synthetic-access'));
 const changed=f.local.current();await writeFile(f.config,'model = "gpt-6.1-terra"\n');assert.notEqual(f.local.current().fingerprint,changed.fingerprint);
});

test('provider credentials follow only the selected environment and are never persisted in profiles',async t=>{
 const f=await fixture(t),name='LAKE_CODEX_UNIT_PROVIDER_SECRET';process.env[name]='synthetic-provider-secret';
 t.after(async()=>{delete process.env[name];});
 await writeFile(f.config,'model_provider = "fixture"\n[model_providers.fixture]\nenv_key = "'+name+'"\n');
 const info=f.local.current();assert.equal(info.environment[name],'synthetic-provider-secret');assert.ok(f.secrets.has('synthetic-provider-secret'));
 process.env[name]='synthetic-provider-changed';assert.notEqual(f.local.current().fingerprint,info.fingerprint);
 const store=await LakeStore.open(join(f.home,'lake'),join(f.home,'data'));t.after(async()=>{store.db.close();});
 const project=store.createProject('local source'),registry=new ExternalAgentRegistry(store,{codexHome:f.source,registerSecret:value=>f.secrets.add(value)});
 store.put('acpProfiles',project.id+':codex',{...registry.get(project.id,'codex'),enabled:true});
 assert.ok(!JSON.stringify(store.list('acpProfiles')).includes('synthetic-provider'));
});

test('migration and source changes fence old bindings without rewriting their history or copying login',async t=>{
 const f=await fixture(t),store=await LakeStore.open(join(f.home,'lake'),join(f.home,'data'));t.after(async()=>{store.db.close();});
 const project=store.createProject('legacy profile'),key=project.id+':codex';
 store.put('acpProfiles',key,{schemaVersion:1,id:'codex',projectId:project.id,revision:4,enabled:true,model:'obsolete-model'});
 const frozen={execution:{kind:'acp',agent:'codex',revision:4}};store.put('superWorkers','old-worker',frozen);
 const registry=new ExternalAgentRegistry(store,{codexHome:f.source}),profile=registry.get(project.id,'codex');
 assert.equal(profile.schemaVersion,2);assert.equal(profile.revision,5);assert.equal(profile.authentication,'codex-local');assert.equal((profile as any).model,undefined);
 await f.login('account-a','refresh');assert.equal(registry.get(project.id,'codex').revision,5);
 await f.login('account-b','switch');assert.equal(registry.get(project.id,'codex').revision,6);assert.deepEqual(store.get('superWorkers','old-worker'),frozen);
 const before=await readFile(f.auth,'utf8'),managed=await registry.prepareHome(profile);
 await assert.rejects(readFile(join(managed,'auth.json')));await assert.rejects(readFile(join(managed,'config.toml')));assert.equal(await readFile(f.auth,'utf8'),before);
});

test('malformed local configuration gives an actionable blocker without preventing native Lake startup',async t=>{
 const f=await fixture(t),store=await LakeStore.open(join(f.home,'lake'),join(f.home,'data'));t.after(async()=>{store.db.close();});
 const project=store.createProject('invalid config');await writeFile(f.config,'model = [ invalid secret-do-not-echo');
 const registry=new ExternalAgentRegistry(store,{codexHome:f.source});const profile=registry.get(project.id,'codex');store.put('acpProfiles',project.id+':codex',{...profile,enabled:true});
 const status=(await registry.list(project.id))[0];assert.match(status.assignmentBlocker!,/格式无效/);assert.ok(!JSON.stringify(status).includes('secret-do-not-echo'));
});

test('startup overrides disable inherited services with literal IDs and preserve native model choice',()=>{
 const args=codexStartupArgs('/private/lake', ['a.b','a"b'],{SessionStart:[{}]}),config=Object.fromEntries(Array.from({length:args.length/2},(_,i)=>{const override=args[i*2+1],index=override.indexOf('=');return [override.slice(0,index),parse('value = '+override.slice(index+1)).value];}));
 assert.deepEqual(config.mcp_servers,{'a.b':{enabled:false},'a"b':{enabled:false}});assert.deepEqual(config.hooks,{SessionStart:[]});assert.deepEqual(config.notify,[]);
 assert.equal(config.model,undefined);assert.equal(config.model_provider,undefined);assert.equal(config.model_reasoning_effort,undefined);
 assert.equal(config.sqlite_home,'/private/lake/state');assert.equal(shellQuote("one'two"),"'one'\\''two'");
});

test('role model overrides keep local login and max intact and concurrent launch configurations use distinct immutable files',async t=>{
 const f=await fixture(t),store=await LakeStore.open(join(f.home,'lake'),join(f.home,'data'));t.after(async()=>{store.db.close();});
 const project=store.createProject('parallel model launch'),registry=new ExternalAgentRegistry(store,{codexHome:f.source});
 const profile={...registry.get(project.id,'codex'),enabled:true,nodePath:process.execPath};store.put('acpProfiles',project.id+':codex',profile);
 const before=[await readFile(f.config,'utf8'),await readFile(f.auth,'utf8')];
 registry.local.inspect=async(_node,_engine,_directory,overrides)=>{
  const model=overrides.find(value=>value.startsWith('model='));
  return {model:model?parse('value = '+model.slice('model='.length)).value as string:'gpt-6.1-sol',provider:'openai',reasoningEffort:'max',authenticated:true,authMode:'chatgpt',mcpIds:[],hooks:{},environment:f.local.current().environment};
 };
 const signal=new AbortController().signal;
 const [inherited,selected]=await Promise.all([registry.prepareLaunch(profile,signal),registry.prepareLaunch(profile,signal,'gpt-6.1-sol')]);
 assert.notEqual(inherited.launcher,selected.launcher);
 const original=await readFile(inherited.launcher,'utf8'),overridden=await readFile(selected.launcher,'utf8');
 assert.ok(!original.includes('model='));assert.ok(overridden.includes('model='));assert.ok(overridden.includes('gpt-6.1-sol'));
 assert.equal(selected.observed.reasoningEffort,'max');assert.equal(selected.observed.authenticated,true);
 await registry.prepareLaunch(profile,signal,'gpt-6.1-sol');assert.equal(await readFile(inherited.launcher,'utf8'),original);
 assert.deepEqual([await readFile(f.config,'utf8'),await readFile(f.auth,'utf8')],before);
 await assert.rejects(registry.prepareLaunch(profile,signal,'unverified-model'),/兼容目录/);
});
