import { access, readFile, realpath, rm } from 'node:fs/promises';
import { join, isAbsolute, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { externalAgentId, externalAgentIds, externalProducts } from './catalog';
import type { ExternalAgentId, ExternalAgentProfile, ExternalAgentStatus } from './types';
import { HttpError, LakeStore, now } from '../store';
import { privateFile, privatePath } from './private';
import { codexCatalog, codexModels, codexConfig, tomlConfig } from './codex-profile';
import {discoverCodexRuntime,validateCodexNode} from './runtime-paths';

export class ExternalAgentRegistry {
  private mutations = new Map<string, Promise<unknown>>();
  private installation?: Promise<unknown>;
  constructor(readonly store: LakeStore) {}
  private key(projectId: string, id: ExternalAgentId) { this.store.require('projects', projectId); return projectId + ':' + id; }
  get(projectId: string, agent: unknown): ExternalAgentProfile {
    const id = externalAgentId(agent), key = this.key(projectId, id);
    const profile=this.store.get<ExternalAgentProfile>('acpProfiles',key);
    if(profile&&profile.schemaVersion!==1)throw new HttpError(409,'外部 Agent 配置版本不受当前版本支持');
    return profile??{schemaVersion:1,id,projectId,revision:0,enabled:false,updatedAt:now()};
  }
  revision(projectId: string) { return externalAgentIds.map(id => this.get(projectId, id).revision).join(':'); }
  adapterRoot() { return join(this.store.home, 'external-agents', 'adapters', 'codex'); }
  adapterEntry() { return join(this.adapterRoot(), 'node_modules', '@agentclientprotocol', 'codex-acp', 'dist', 'index.js'); }
  async list(projectId: string): Promise<ExternalAgentStatus[]> {
    return Promise.all(externalAgentIds.map(async id => {
      const profile = this.get(projectId, id);
      let installed = false;
      try {
        const manifest = JSON.parse(await readFile(join(dirname(this.adapterEntry()), '../package.json'), 'utf8'));
        const engine = JSON.parse(await readFile(join(this.adapterRoot(), 'node_modules/@openai/codex/package.json'), 'utf8'));
        await access(this.adapterEntry());await access(profile.nodePath!);
        installed = manifest.version === externalProducts.codex.version && engine.version === '0.160.1';
      } catch { /* unavailable */ }
      const probe = this.store.get<{ revision: number; ready: boolean; message?: string; capabilities?: Record<string, unknown> }>('acpProbes', this.key(projectId,id));
      const transportReady=installed && probe?.revision===profile.revision && probe.ready===true;
      const authenticated=!!await this.store.secret('external-agent-'+projectId+'-codex');
      const assignmentBlocker=!profile.enabled?'尚未启用，请在 Agent 设置中启用并保存':
        id==='codex'&&process.platform!=='darwin'?'当前平台的 Codex 执行尚未开放':
        !installed?'尚未安装，请配置 Node 并安装适配器':
        !authenticated?'尚未配置 Codex 独立 API Key':
        !transportReady?'尚未验证当前连接，请在 Agent 设置中测试连接':undefined;
      return { ...profile, name: externalProducts[id].name, installed,
        transportReady,assignmentReady:!assignmentBlocker,assignmentBlocker,
        message: !installed ? '请配置独立 Node 运行时并安装 ACP 适配器' : probe?.revision === profile.revision ? probe.message : undefined,
        capabilities: probe?.revision === profile.revision ? probe.capabilities : undefined };
    }));
  }
  async save(projectId: string, agent: unknown, input: Record<string, unknown>) {
    const id=externalAgentId(agent), key=this.key(projectId,id), previous=this.mutations.get(key)??Promise.resolve();
    const work=previous.catch(()=>{}).then(async()=>{
      const current=this.get(projectId,id);
      if(input.expectedRevision!==current.revision)throw new HttpError(409,'外部 Agent 配置已变化，请刷新后重试');
      if(typeof input.enabled!=='boolean')throw new HttpError(400,'需要明确是否启用 Agent');
      let nodePath=current.nodePath;
      let npmPath=current.npmPath;
      if(input.nodePath!==undefined){
        if(input.nodePath==='')nodePath=undefined;
        else {
          if(typeof input.nodePath!=='string'||!isAbsolute(input.nodePath)||/[\0\r\n]/.test(input.nodePath))throw new HttpError(400,'Node 需要准确绝对路径');
          nodePath=await realpath(input.nodePath);await this.validateNode(nodePath);
        }
      }
      if(input.npmPath!==undefined){
        if(input.npmPath==='')npmPath=undefined;
        else if(typeof input.npmPath!=='string'||!isAbsolute(input.npmPath)||/[\0\r\n]/.test(input.npmPath))throw new HttpError(400,'npm 需要准确绝对路径');
        else npmPath=await realpath(input.npmPath);
      }
      if(input.autoDetect===true||input.enabled&&(!nodePath||!npmPath))({nodePath,npmPath}=await discoverCodexRuntime(nodePath,npmPath));
      const model=input.model??current.model;
      if(model!==undefined&&(typeof model!=='string'||!codexModels.includes(model)))throw new HttpError(400,'请选择受支持的 Codex 模型');
      if(input.apiKey!==undefined&&(id!=='codex'||typeof input.apiKey!=='string'||input.apiKey.length>16384||/[\r\n\0]/.test(input.apiKey)))throw new HttpError(400,'外部 Agent 凭据无效');
      if(input.apiKey!==undefined)await this.store.secret('external-agent-'+projectId+'-codex',input.apiKey as string||null);
      const profile:ExternalAgentProfile={...current,nodePath,npmPath,model:model as string|undefined,enabled:input.enabled,revision:current.revision+1,updatedAt:now()};
      return this.store.put('acpProfiles',key,profile);
    });
    this.mutations.set(key,work);
    try{return await work;}finally{if(this.mutations.get(key)===work)this.mutations.delete(key);}
  }
  async validateNode(path:string){await validateCodexNode(path);}
  async prepareHome(profile: ExternalAgentProfile) {
    const home = await privatePath(this.store.home,'external-agents','profiles',profile.projectId,profile.id);
    if(profile.id==='codex'){
      const key=await this.store.secret('external-agent-'+profile.projectId+'-codex');
      if(key)await privateFile(home,'auth.json',JSON.stringify({OPENAI_API_KEY:key}));
      else await rm(join(home,'auth.json'),{force:true});
      await privateFile(home,'models.json',JSON.stringify(codexCatalog));
      await privateFile(home,'config.toml',tomlConfig(codexConfig(home,profile.model)));
    }
    return home;
  }
  async install(projectId: string, agent: unknown, npmPath: unknown, signal: AbortSignal) {
    const profile=this.get(projectId,agent);
    if(this.installation)throw new HttpError(409,'Codex ACP 适配器正在安装');
    npmPath=npmPath??profile.npmPath;
    if(!profile.nodePath||typeof npmPath!=='string'||!isAbsolute(npmPath)||/[\0\r\n]/.test(npmPath))throw new HttpError(400,'未识别到 Node/npm，请重新启用自动识别或检查高级设置');
    const node=profile.nodePath,npm=await realpath(npmPath);await this.validateNode(node);
    if(this.installation||this.store.list<any>('acpRuns').some(run=>run.agent==='codex'&&['starting','running'].includes(run.state)))throw new HttpError(409,'请等待 Codex 当前运行结束后再安装适配器');
    const work=(async()=>{
      const root=await privatePath(this.store.home,'external-agents','adapters','codex');
      const cache=await privatePath(this.store.home,'external-agents','npm-cache');
      // The adapter's engine dependency is a range. Pin the engine independently.
      await new Promise<void>((resolve,reject)=>{
        const proc=spawn(node,[npm,'install','--prefix',root,'--ignore-scripts','--no-audit','--no-fund','--save-exact','@agentclientprotocol/codex-acp@2.2.2','@openai/codex@0.160.1'],
          {env:{PATH:dirname(node)+(process.platform==='win32'?';':':')+(process.env.PATH??''),HOME:this.store.home,npm_config_cache:cache},stdio:'ignore',signal,shell:false});
        proc.once('error',reject);proc.once('exit',code=>code===0?resolve():reject(new Error('ACP 适配器安装失败，请检查运行时和网络')));
      });
      const manifest=JSON.parse(await readFile(join(root,'node_modules/@agentclientprotocol/codex-acp/package.json'),'utf8'));
      if(manifest.version!==externalProducts.codex.version)throw new Error('ACP 适配器版本与固定版本不符');
      return {installed:true,version:manifest.version};
    })();this.installation=work;
    try{return await work;}finally{this.installation=undefined;}
  }
}
