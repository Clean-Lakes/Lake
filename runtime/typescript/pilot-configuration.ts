import type {Resource,ResourceTreeNode,Message,MCPServerConfig} from '../../web-agent/shared/contracts';
import type {ToolEntry,ToolExecutionContext} from './sdk';
import {LakeStore,HttpError,now} from './store';
import {digest,text} from './tasks';
import type {LakeSecurity} from './security';
import type {LakeExtensions} from './extensions';
import {LakeResourceManagement} from './resource-management';
import {operationApproval} from './operation-permissions';
import {redactModelValue} from './model-errors';

export {pilotConfigurationToolNames} from './configuration-tool-names';
type Input=Record<string,any>;
export type ConfigurationEvent={id:string;projectId:string;sessionId:string;messageId:string;payload:string;preferredRoleId?:string};
type Admission=(eventId:string,quote:string)=>ConfigurationEvent;
type Receipt={hash:string;eventId:string;projectId:string;tool:string;state:'pending'|'committed'|'unknown';result?:unknown;at:string};
const str={type:'string'},bool={type:'boolean'},integer={type:'integer'};
const object=(properties:Record<string,unknown>,required:string[]=[])=>({type:'object',properties,required,additionalProperties:false});
const list=(items:unknown)=>({type:'array',items});
const source={event_id:str,part_key:str,quote:str,expected_revision:str};
const requiredSource=['event_id','part_key','quote','expected_revision'];
const publicSettings=['shell','driver','host','port','username','database','tls','sslmode','db','endpoint','authMethod'];
const sshFields=['host','port','username','authMethod','shell'];
const mcpFields=['name','transport','enabled','url','command','args','timeoutMs','protocolVersion'];
const secretArgument=/(?:^|[-_])(password|passphrase|token|secret|api[-_]?key|authorization|credential)(?:$|[-_=])/i;
function fields(input:unknown,allowed:string[],label:string):asserts input is Input {
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!allowed.includes(key)))throw new HttpError(400,label+'包含不支持的字段');
}
function expected(value:unknown,revision:string){if(value!==revision)throw new HttpError(409,'配置已变化，请重新查询准确对象和 revision');}
function page<T>(items:T[],input:Input,revision:string){
 const limit=input.limit??20,offset=input.offset??0;
 if(!Number.isSafeInteger(limit)||limit<1||limit>50||!Number.isSafeInteger(offset)||offset<0)throw new HttpError(400,'分页参数无效');
 if(offset>0)expected(input.catalog_revision,revision);
 const selected:T[]=[];let bytes=0;
 for(const item of items.slice(offset,offset+limit)){
  const size=Buffer.byteLength(JSON.stringify(item));if(bytes+size>49152)break;selected.push(item);bytes+=size;
 }
 if(!selected.length&&offset<items.length)throw new HttpError(413,'此配置条目过大，请在设置中查看');
 return {items:selected,total:items.length,...(offset+selected.length<items.length?{next_offset:offset+selected.length}:{}),catalog_revision:revision};
}
function query(value:unknown){if(value===undefined)return '';return text(value,'query',1024).normalize('NFKC').toLowerCase();}
const matches=(value:unknown,search:string)=>!search||JSON.stringify(value).normalize('NFKC').toLowerCase().includes(search);

/** Configuration is control-plane state, not business evidence or a grant. */
export class PilotConfiguration {
 constructor(readonly store:LakeStore,readonly security:LakeSecurity,readonly extensions:LakeExtensions,
  readonly resources:LakeResourceManagement,readonly redact:(value:string)=>string){}
 private actor(sessionId:string){
  const session=this.store.session(sessionId),project=this.store.get<any>('superProjects',session.projectId);
  if(session.workspaceRole!=='router'||project?.routerSessionId!==sessionId)throw new HttpError(403,'配置管理仅供当前项目 Pilot 使用');
  this.store.project(session.projectId);return session;
 }
 private resourceState(projectId:string){
  const catalog=this.store.catalog(),resources=catalog.resources.filter(r=>r.projectId===projectId),nodes=(catalog.resourceTree??[]).filter(n=>n.projectId===projectId);
  return {resources,nodes,revision:digest([resources,nodes])};
 }
 private path(node:ResourceTreeNode,nodes:ResourceTreeNode[]){
  const parts=[node.name],seen=new Set([node.id]);let cursor=node.parentId;
  while(cursor){const parent=nodes.find(n=>n.id===cursor);if(!parent||parent.kind!=='folder'||seen.has(cursor)||seen.size>=32)return null;seen.add(cursor);parts.unshift(parent.name);cursor=parent.parentId;}
  return parts.join(' / ');
 }
 private resourceItem(resource:Resource,nodes:ResourceTreeNode[]){
  const node=nodes.find(n=>n.resourceId===resource.id),ssh=resource.ssh;
  const settings=Object.fromEntries(Object.entries(resource.settings??{}).filter(([key])=>publicSettings.includes(key)));
  return {id:resource.id,entity:'resource',name:resource.name,kind:resource.kind,status:resource.status,description:resource.description,
   parent_id:node?.parentId??null,node_id:node?.id,path:node?this.path(node,nodes):resource.name,
   revision:digest([resource,node]),settings,...(ssh?{ssh:Object.fromEntries(sshFields.filter(k=>ssh[k as keyof typeof ssh]!==undefined).map(k=>[k,ssh[k as keyof typeof ssh]])),credentials_configured:!!(ssh.authMethod==='password'?ssh.credentialRef:ssh.identityFile)}:{})};
 }
 private folderRevision(node:ResourceTreeNode,nodes:ResourceTreeNode[]){
  const children=new Set([node.id]);for(let i=0;i<32;i++){const size=children.size;for(const n of nodes)if(n.parentId&&children.has(n.parentId))children.add(n.id);if(children.size===size)break;}
  return digest(nodes.filter(n=>children.has(n.id)));
 }
 listResources(sessionId:string,input:Input){
  const {projectId}=this.actor(sessionId),state=this.resourceState(projectId),search=query(input.query);
  const items:any[]=[...state.nodes.filter(n=>n.kind==='folder').map(n=>({id:n.id,entity:'folder',name:n.name,parent_id:n.parentId,path:this.path(n,state.nodes),revision:this.folderRevision(n,state.nodes)})),
   ...state.resources.map(r=>this.resourceItem(r,state.nodes))];
  if(input.include_deleted)for(const item of this.resources.navigation.trash().items.filter(i=>i.projectId===projectId&&i.kind!=='project'))items.push({...item,entity:item.kind,deleted:true,revision:digest(item)});
  const revision=digest([state.revision,items]);
  return {scope:'project',...page(items.filter(item=>(!input.id||item.id===input.id)&&matches(item,search)).sort((a,b)=>a.id.localeCompare(b.id)),input,revision)};
 }
 private resourceChange(projectId:string,event:ConfigurationEvent,a:Input):()=>unknown {
  fields(a,[...requiredSource,'entity','action','id','name','description','kind','parent_id','ssh','settings','credential_source_id'],'资源修改');
  const state=this.resourceState(projectId),entity=a.entity;
  if(!['resource','folder'].includes(entity)||!['create','update','delete','restore'].includes(a.action))throw new HttpError(400,'资源操作无效');
  const input:Input={};for(const key of ['name','description','kind','ssh','settings'])if(Object.hasOwn(a,key))input[key]=a[key];
  if(Object.hasOwn(a,'parent_id')){input.parentId=this.resources.navigation.parent(projectId,a.parent_id);}
  if(a.ssh!==undefined){fields(a.ssh,sshFields,'SSH 连接');}
  if(a.settings!==undefined){fields(a.settings,publicSettings,'资源连接');}
  if(a.name!==undefined)text(a.name,'name',160);
  if(entity==='folder'&&['description','kind','ssh','settings','credential_source_id'].some(k=>Object.hasOwn(a,k)))throw new HttpError(400,'文件夹仅接受名称和父目录');
  if(a.action==='restore'){
   const item=this.resources.navigation.trash().items.find(i=>i.id===a.id&&i.kind===entity&&i.projectId===projectId);if(!item)throw new HttpError(404,'当前项目回收站没有此对象');expected(a.expected_revision,digest(item));
   return ()=>{this.resources.navigation.restore(entity,a.id);return {id:a.id,entity,restored:true,scope:'project'};};
  }
  if(a.action==='create'){
   if(a.id!==undefined)throw new HttpError(400,'新建对象不能指定既有 ID');expected(a.expected_revision,state.revision);
   if(a.credential_source_id!==undefined){
    if(entity!=='resource'||a.kind!=='ssh')throw new HttpError(400,'凭据来源仅适用于新 SSH 资源');
    const from=state.resources.find(r=>r.id===a.credential_source_id&&r.kind==='ssh'&&r.status==='available');if(!from)throw new HttpError(404,'凭据来源须为当前项目可用的 SSH 资源');
    input.ssh={...this.resources.ssh.configuration(from.ssh),...a.ssh};
   }
   if(entity==='folder')return ()=>{const before=new Set(state.nodes.map(n=>n.id));const result=this.resources.navigation.edit(projectId,{operation:'create',...input});return {scope:'project',item:result.nodes.find(n=>!before.has(n.id))};};
   if(a.kind==='local'&&a.settings!==undefined)fields(a.settings,['shell'],'本机配置');
   return ()=>{const resource=this.resources.create(projectId,input,true),next=this.resourceState(projectId);return {scope:'project',item:this.resourceItem(resource,next.nodes),connection_tested:false,credential_setup_required:resource.kind==='ssh'&&resource.status!=='available'};};
  }
  if(a.credential_source_id!==undefined||a.kind!==undefined)throw new HttpError(400,'已有资源不能更换类型或复制其他凭据');
  const node=state.nodes.find(n=>entity==='folder'?n.id===a.id&&n.kind==='folder':n.resourceId===a.id);
  if(!node)throw new HttpError(404,'当前项目没有此资源或文件夹');
  const resource=entity==='resource'?state.resources.find(r=>r.id===a.id):undefined;
  expected(a.expected_revision,resource?this.resourceItem(resource,state.nodes).revision:this.folderRevision(node,state.nodes));
  if(a.action==='delete')return ()=>{this.resources.navigation.edit(projectId,{operation:'delete',nodeId:node.id},{sessionId:event.sessionId,eventId:event.id});return {scope:'project',id:a.id,entity,archived:true,history_deleted:false};};
  if(!['name','description','parent_id','ssh','settings'].some(k=>Object.hasOwn(a,k)))throw new HttpError(400,'没有需要修改的配置');
  // Validate folder ancestry/cycles before any connection or metadata write.
  if(input.parentId!==undefined){let cursor=input.parentId;while(cursor){if(cursor===node.id)throw new HttpError(409,'不能将目录移入自身或子目录');cursor=state.nodes.find(n=>n.id===cursor)?.parentId??null;}}
  if(resource?.kind==='local'&&a.settings!==undefined)fields(a.settings,['shell'],'本机配置');
  return ()=>{
   if(entity==='folder'){this.resources.navigation.edit(projectId,{operation:'update',nodeId:node.id,...input});return {scope:'project',id:node.id,updated:true};}
   const updated=this.resources.update(resource!,input,true);
   if(Object.hasOwn(a,'parent_id'))this.resources.navigation.edit(projectId,{operation:'move',nodeId:node.id,parentId:input.parentId});
   return {scope:'project',item:this.resourceItem(updated,this.resourceState(projectId).nodes),connection_tested:false};
  };
 }
 private skillState(){const catalog=this.extensions.skills();return {catalog,revision:digest(catalog)};}
 listSkills(sessionId:string,a:Input){
  this.actor(sessionId);const {catalog,revision}=this.skillState(),search=query(a.query);
  if(a.entity==='root')return {scope:'global',roots_revision:digest(catalog.roots),...page(catalog.roots.filter(path=>matches(path,search)).map(path=>({path})),a,digest(catalog.roots))};
  if(a.name){const value=this.extensions.skill(text(a.name,'name',80));return {scope:'global',...value,revision:this.extensions.skillRevision(a.name),catalog_revision:revision};}
  return {scope:'global',roots_count:catalog.roots.length,roots_revision:digest(catalog.roots),default_root:catalog.defaultRoot,
   ...page(catalog.skills.filter(item=>matches(item,search)).map(item=>({...item,revision:this.extensions.skillRevision(item.name)})),a,revision)};
 }
 private skillChange(a:Input):()=>unknown {
  fields(a,[...requiredSource,'scope','entity','action','name','content','enabled','path'],'Skill 修改');
  if(a.scope!=='global'||!['skill','root'].includes(a.entity)||!['create','update','delete'].includes(a.action))throw new HttpError(400,'请明确修改 Lake 全局 Skill 或注册目录');
  const {catalog,revision}=this.skillState();
  if(a.entity==='root'){
   if(a.action==='update'||['name','content','enabled'].some(k=>Object.hasOwn(a,k)))throw new HttpError(400,'Skill 目录仅支持注册或移除 path');
   text(a.path,'path',4000);expected(a.expected_revision,digest(catalog.roots));
   return ()=>{this.extensions.skillRoot(a.path,a.action==='delete');const roots=this.extensions.skills().roots;return {scope:'global',path:a.path,registered:a.action==='create',roots_count:roots.length,roots_revision:digest(roots),files_deleted:false};};
  }
  if(a.path!==undefined)throw new HttpError(400,'Skill 内容使用准确 name，不接受文件路径');
  text(a.name,'name',80);if(a.enabled!==undefined&&typeof a.enabled!=='boolean')throw new HttpError(400,'enabled 须为布尔值');
  if(a.action==='create'){expected(a.expected_revision,revision);if(catalog.skills.some(s=>s.name.toLowerCase()===a.name.toLowerCase()))throw new HttpError(409,'已存在同名 Skill');text(a.content,'content',100000);}
  else {const skill=catalog.skills.find(s=>s.name===a.name);if(!skill)throw new HttpError(404,'Skill 不存在');expected(a.expected_revision,this.extensions.skillRevision(a.name));if(a.content!==undefined&&!skill.managed)throw new HttpError(409,'导入 Skill 的内容只读；可管理启用状态或解除注册');}
  if(a.action==='delete'){
   if(a.content!==undefined||a.enabled!==undefined)throw new HttpError(400,'删除不能同时修改内容或启用状态');
   return ()=>this.extensions.removeSkill(a.name);
  }
  if(a.action==='update'&&a.content===undefined&&a.enabled===undefined)throw new HttpError(400,'没有需要修改的 Skill 配置');
  if(a.content!==undefined)text(a.content,'content',100000);
  return ()=>{this.extensions.saveSkill(a.name,{...(a.content!==undefined?{content:a.content}:{}),...(a.enabled!==undefined?{enabled:a.enabled}:a.action==='create'?{enabled:true}:{}),create:a.action==='create'});return {scope:'global',name:a.name,saved:true,revision:this.extensions.skillRevision(a.name)};};
 }
 private mcpState(){const servers=this.extensions.servers().servers;return {servers,revision:digest(servers.map(s=>[s.id,this.extensions.serverRevision(s.id)]))};}
 private publicServer(server:MCPServerConfig){
  let mask=false,redacted=false;
  const args=server.args.map(arg=>{if(mask){mask=false;redacted=true;return '[REDACTED]';}if(secretArgument.test(arg)){redacted=true;if(arg.includes('='))return arg.slice(0,arg.indexOf('=')+1)+'[REDACTED]';mask=true;}return this.redact(arg);});
  const bounded:string[]=[];let bytes=0;
  for(const arg of args){const size=Buffer.byteLength(JSON.stringify(arg));if(bytes+size>8192)break;bounded.push(arg);bytes+=size;}
  return {...server,args:bounded,...(redacted?{arguments_redacted:true}:{}),...(bounded.length<args.length?{arguments_truncated:true}:{}),revision:this.extensions.serverRevision(server.id)};
 }
 listMCP(sessionId:string,a:Input){
  const {projectId}=this.actor(sessionId),{servers,revision}=this.mcpState(),bindings=this.extensions.bindings(projectId).bindings;
  if(a.tools_for){
   if(!servers.some(s=>s.id===a.tools_for))throw new HttpError(404,'MCP 服务不存在');
   const catalog=this.store.get<any>('mcpCatalogs',a.tools_for);
   if(!catalog||catalog.configurationHash!==this.extensions.serverRevision(a.tools_for))throw new HttpError(409,'请先测试当前 MCP 连接');
   return {scope:'global',server_id:a.tools_for,...page(catalog.tools.filter((t:any)=>matches([t.name,t.description],query(a.query))).map((t:any)=>({name:t.name,description:String(t.description??'').slice(0,300)})),a,digest([catalog.configurationHash,catalog.hash]))};
  }
  return {scope:'global',inheritance:this.extensions.inheritance(projectId).Enabled,
   ...page(servers.filter(s=>(!a.id||s.id===a.id)&&matches([s.id,s.name],query(a.query))).map(s=>{
    const binding=bindings.find(b=>b.ServerID===s.id),names=binding?.ToolNames;
    return {...this.publicServer(s),project_binding_revision:binding?.Revision??0,project_enabled:binding?.Enabled,
     ...(names?{project_tool_names:names.slice(0,50),project_tool_names_total:names.length}:{} )};
   }),a,revision)};
 }
 private mcpChange(projectId:string,a:Input):()=>unknown {
  fields(a,[...requiredSource,'scope','action','id','config','enabled','tool_names','binding_revision'],'MCP 修改');
  const {servers,revision}=this.mcpState();
  if(a.action==='bind'){
   if(a.scope!=='project'||a.config!==undefined)throw new HttpError(400,'项目启用使用 scope project，不修改全局服务配置');
   const server=servers.find(s=>s.id===a.id);if(!server)throw new HttpError(404,'MCP 服务不存在');expected(a.expected_revision,this.extensions.serverRevision(server.id));
   if(typeof a.enabled!=='boolean'||!Number.isSafeInteger(a.binding_revision))throw new HttpError(400,'项目启用状态或绑定版本无效');
   const binding=this.extensions.bindings(projectId).bindings.find(b=>b.ServerID===server.id);
   if(a.enabled&&!binding&&!Object.hasOwn(a,'tool_names'))throw new HttpError(400,'首次启用请选择实际工具；明确启用全部时传空数组');
   const names=a.tool_names??binding?.ToolNames??[];
   return ()=>({scope:'project',binding:this.extensions.setBinding(projectId,server.id,{enabled:a.enabled,toolNames:names,expectedRevision:a.binding_revision,actionId:digest([a.event_id,a.part_key])})});
  }
  if(a.scope!=='global'||!['create','update','delete'].includes(a.action)||['enabled','tool_names','binding_revision'].some(k=>Object.hasOwn(a,k)))throw new HttpError(400,'服务配置须明确 scope global；项目启用使用 bind');
  if(a.action==='create'){if(a.id!==undefined)throw new HttpError(400,'新服务不能指定既有 ID');expected(a.expected_revision,revision);}
  else {if(!servers.some(s=>s.id===a.id))throw new HttpError(404,'MCP 服务不存在');expected(a.expected_revision,this.extensions.serverRevision(a.id));}
  if(a.action==='delete'){if(a.config!==undefined)throw new HttpError(400,'删除不能同时修改配置');return ()=>{this.extensions.remove(a.id);return {scope:'global',id:a.id,deleted:true};};}
  fields(a.config,mcpFields,'MCP 配置');if(!Object.keys(a.config).length)throw new HttpError(400,'没有需要保存的配置');
  if(a.config.args!==undefined&&(!Array.isArray(a.config.args)||a.config.args.some((arg:unknown)=>typeof arg!=='string'||secretArgument.test(arg))))throw new HttpError(400,'认证参数请在 MCP 设置中保存，模型管理工具不接受秘密值');
  return ()=>{const saved=a.action==='create'?this.extensions.save(undefined,{enabled:true,...a.config}):this.extensions.patch(a.id,a.config);return {scope:'global',server:this.publicServer(saved),connection_tested:false};};
 }
 private async mutate(sessionId:string,tool:string,a:Input,context:ToolExecutionContext,admit:Admission){
  const session=this.actor(sessionId);this.security.check();
  if(session.options.conversationMode==='plan')throw new HttpError(403,'Plan 模式只查询配置，退出计划模式后才能保存');
  if(context.abortSignal.aborted)throw new HttpError(409,'当前配置请求已取消');
  const event=admit(text(a.event_id,'event_id',128),text(a.quote,'quote',16384)),message=this.store.get<Message>('messages',event.messageId);
  if(event.sessionId!==sessionId||event.projectId!==session.projectId||event.preferredRoleId||message?.role!=='user'||message.sessionId!==sessionId)throw new HttpError(403,'配置变更需要当前 Pilot 的真实人工输入');
  const part=text(a.part_key,'part_key',128),key=digest([event.id,part]),hash=digest([tool,a]);
  const prior=this.store.get<Receipt>('pilotConfigMutations',key);
  if(prior){if(prior.hash!==hash||prior.projectId!==session.projectId)throw new HttpError(409,'同一配置动作的参数发生冲突');if(prior.state!=='committed')throw new HttpError(409,'原配置提交结果未确认；请先读取当前配置，不会自动重复原动作');return prior.result;}
  if(this.store.list<Receipt>('pilotConfigMutations').filter(r=>r.eventId===event.id).length>=32)throw new HttpError(409,'本轮配置动作超过上限');
  let apply:()=>unknown|Promise<unknown>;
  if(tool==='manage_resource'){
   // Creation uses the resource collection revision, not the combined public page.
   apply=this.resourceChange(session.projectId,event,a);
  }else if(tool==='manage_skill')apply=this.skillChange(a);
  else if(tool==='manage_mcp')apply=this.mcpChange(session.projectId,a);
  else {
   fields(a,[...requiredSource,'id'],'MCP 连接测试');expected(a.expected_revision,this.extensions.serverRevision(a.id));
   const server=this.extensions.servers().servers.find(s=>s.id===a.id);if(!server)throw new HttpError(404,'MCP 服务不存在');
   if(server.transport==='stdio'&&session.options.denyLocalExecution===true)throw new HttpError(403,'当前 Pilot 禁止本机 MCP 进程');
   this.security.mcp(session.projectId,'mcp.discover',server.transport==='stdio');
   apply=async()=>{const result=await this.extensions.test(server.id,context.abortSignal);admit(event.id,a.quote);this.security.check();return {scope:'global',id:server.id,connection_tested:true,tools:result.tools.slice(0,50).map(t=>({name:t.name})),tools_total:result.tools.length,tools_truncated:result.tools.length>50,revision:this.extensions.serverRevision(server.id)};};
  }
  const record:Receipt={hash,eventId:event.id,projectId:session.projectId,tool,state:'pending',at:now()};
  // Commit before crossing the filesystem/network transaction domain. A crash
  // leaves pending, and exact replay is blocked rather than repeating the I/O.
  this.store.put('pilotConfigMutations',key,record);
  try{
   const result=redactModelValue(await apply(),this.redact);
   this.store.put('pilotConfigMutations',key,{...record,state:'committed',result});return result;
  }catch(error){this.store.put('pilotConfigMutations',key,{...record,state:'unknown'});throw error instanceof HttpError?error:new HttpError(409,'配置提交未确认，请查询当前配置后再决定下一步');}
 }
 entries(sessionId:string,admit:Admission,notify:()=>void):ToolEntry[]{
  const definition=(name:string,description:string,schema:any,read:boolean,handler:(a:Input,c:ToolExecutionContext)=>unknown):ToolEntry=>{
   const entry:ToolEntry={metadata:{name,description,readOnly:read,destructive:!read,concurrentSafe:false,allowedInPlanMode:read,sideEffectScope:read?'session':'system',riskLevel:read?'low':'medium',needsApproval:false},
    capability:description,inputSchema:schema,outputSchema:{},permission:{permission:'lake.configuration',reason:description,riskLevel:read?'low':'medium',sideEffectScope:read?'session':'system',needsApproval:false,patternSources:['toolName'],alwaysAllowPatternSources:['toolName'],denyPriority:'beforeAsk'},
    resultBudget:{maxInlineBytes:131072,maxModelBytes:131072,strategy:'truncate',preview:{maxBytes:131072,direction:'head'}},timeout:{kind:'none'},cancellation:{supported:true,cleanup:'none',userVisibleMessage:'Lake configuration request cancelled'},trace:{required:true,propagateToAdapters:true,recordInput:'summary',recordOutput:'summary'},
    handler:async(a,c)=>{this.actor(sessionId);fields(a,Object.keys(schema.properties),'配置请求');const result=await handler(a,c);if(!read)notify();return redactModelValue(result,this.redact);}};
   entry.resolvePermissionCapability=()=>operationApproval(this.actor(sessionId).options,name==='test_mcp_config'?'silentMCPCalls':read?'silentReadFiles':'silentWriteFiles');
   return entry;
  };
  const paging={query:str,offset:integer,limit:integer,catalog_revision:str};
  const mutation=(name:string,description:string,schema:any)=>definition(name,description,schema,false,(a,c)=>this.mutate(sessionId,name,a,c,admit));
  return [
   definition('list_resource_config','Read current-project resource/folder configuration, exact IDs and revisions; optional id/query. No connections. Copy create_revision for create, item revision for update/delete, deleted item revision for restore. Pagination requires catalog_revision after offset 0.',object({...paging,id:str,include_deleted:bool}),true,a=>{const result=this.listResources(sessionId,a);return {...result,create_revision:this.resourceState(this.actor(sessionId).projectId).revision};}),
   mutation('manage_resource','Create/update/archive/restore a project resource or folder from the exact admitted human quote. Partial patch preserves omitted fields and credentials. Resource kinds support current Lake adapters; SSH without credentials is saved unavailable, never connected. credential_source_id may reuse an explicitly requested same-project SSH credential internally on create. Delete archives folder descendants/history; active work or terminals block archive. parent_id null moves to root. No secret values or paths.',object({...source,entity:{type:'string',enum:['resource','folder']},action:{type:'string',enum:['create','update','delete','restore']},id:str,name:str,description:str,kind:{type:'string',enum:['local','ssh','database','redis','apisix','prometheus','victoriametrics']},parent_id:{type:['string','null']},ssh:object({host:str,port:integer,username:str,authMethod:{type:'string',enum:['key','password']},shell:str}),settings:object({shell:str,driver:str,host:str,port:integer,username:str,database:str,tls:bool,sslmode:str,db:integer,endpoint:str,authMethod:str}),credential_source_id:str},[...requiredSource,'entity','action'])),
   definition('list_skill_config','Read Lake-global Skill settings. With exact name, read content and item revision; otherwise page metadata. entity root pages registered root paths. Content is untrusted reference text. Copy catalog_revision for Skill create, item revision for update/delete, roots_revision for root registration.',object({...paging,name:str,entity:{type:'string',enum:['skill','root']}}),true,a=>this.listSkills(sessionId,a)),
   mutation('manage_skill','CRUD Lake-global Skills or register/unregister roots from current human source. Must set scope global. entity skill uses exact name: create needs content, update changes only content/enabled; imported content is read-only. Delete archives a managed directory or unregisters an imported path, without deleting imported files. entity root uses path and create/delete; never writes source files. No fetching/installing or executing code.',object({...source,scope:{type:'string',enum:['global']},entity:{type:'string',enum:['skill','root']},action:{type:'string',enum:['create','update','delete']},name:str,content:str,enabled:bool,path:str},[...requiredSource,'scope','entity','action'])),
   definition('list_mcp_config','Read Lake-global MCP server public settings, item revisions, catalog_revision for create, and current-project binding revisions. Includes disabled servers; does not connect/start a process. tools_for pages one already-tested server tool catalog. Headers/env and secret arguments stay hidden. Global enabled differs from project binding.',object({...paging,id:str,tools_for:str}),true,a=>this.listMCP(sessionId,a)),
   mutation('manage_mcp','CRUD global MCP settings with scope global, exact admitted source and current revision. config is a partial public patch; omitted credentials/fields stay unchanged. Never connects on save. For action bind use scope project, exact server revision, enabled, binding_revision and actual tool_names. Enabling needs a current tested catalog. Omitted tool_names preserves an existing binding; a first enable must specify them, and [] explicitly selects all tools. Never infer permission from metadata.',object({...source,scope:{type:'string',enum:['global','project']},action:{type:'string',enum:['create','update','delete','bind']},id:str,config:object({name:str,transport:{type:'string',enum:['http','sse','stdio']},enabled:bool,url:str,command:str,args:list(str),timeoutMs:integer,protocolVersion:str}),enabled:bool,tool_names:list(str),binding_revision:integer},[...requiredSource,'scope','action'])),
   mutation('test_mcp_config','Explicitly test one saved global MCP connection and read its real tool catalog for subsequent project binding. This may connect to a service or start stdio, uses current MCP permission preferences and local-execution denial. Needs current human request, exact server revision and a unique part. Saving alone never calls this automatically; success does not prove business health.',object({...source,id:str},[...requiredSource,'id'])),
  ];
 }
}
