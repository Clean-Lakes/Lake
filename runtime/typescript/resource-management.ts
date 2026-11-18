import type {Resource,ResourceTreeNode} from '../../web-agent/shared/contracts';
import {LakeStore,HttpError,id} from './store';
import {digest,text} from './tasks';
import type {LakeSecurity} from './security';
import type {LakeSSH} from './ssh';
import {LakeServiceResources,isServiceKind} from './service-resources';
import {LakeResourceNavigation} from './resource-navigation';

export type PreparedResourceImport={resource:Resource;folder:string;previous?:string};

/** Shared Items writes for the authenticated UI and Pilot; never connects. */
export class LakeResourceManagement {
 constructor(readonly store:LakeStore,readonly security:LakeSecurity,readonly ssh:LakeSSH,
  readonly services:LakeServiceResources,readonly navigation:LakeResourceNavigation){}
 private description(value:unknown,previous='') {
  if(value===undefined)return previous;
  if(typeof value!=='string'||Buffer.byteLength(value)>4096||value.includes('\0'))throw new HttpError(400,'资源描述无效');
  return value;
 }
 create(projectId:string,input:Record<string,any>,allowIncompleteSSH=false){
  this.security.check();this.store.project(projectId);
  const name=text(input.name??(input.kind==='local'?'本机':undefined),'资源名称',160).trim();
  const description=this.description(input.description);
  if(isServiceKind(input.kind,input.settings)){
   const resource=this.services.create(projectId,{...input,name});
   return description?this.store.put('resources',resource.id,{...resource,description}):resource;
  }
  const parentId=this.navigation.parent(projectId,input.parentId);
  if(!['local','ssh'].includes(input.kind))throw new HttpError(501,'此资源类型的连接仍在迁移中');
  const ssh=input.kind==='ssh'?this.ssh.prepare(input.ssh,undefined,allowIncompleteSSH):undefined;
  const complete=!ssh||!!(ssh.authMethod==='password'?ssh.credentialRef:ssh.identityFile);
  const resource:Resource={id:id(),projectId,name,kind:input.kind,description,status:complete?'available':'unavailable',
   ...(ssh?{ssh}:{}),settings:input.settings??{},configurationRevision:1};
  this.store.transaction(()=>{this.store.put('resources',resource.id,resource);this.store.put('resourceRevisions',resource.id,1);this.navigation.attach(resource,parentId);});
  return resource;
 }
 update(resource:Resource,input:Record<string,any>,allowIncompleteSSH=false){
  this.security.check();
  const name=input.name===undefined?resource.name:text(input.name,'资源名称',160).trim(),description=this.description(input.description,resource.description);
  if(isServiceKind(resource.kind,resource.settings)){
   const next=this.services.update(resource,{...input,name});
   return this.store.put('resources',resource.id,{...next,description});
  }
  const settings=input.settings===undefined?resource.settings:input.settings;
  if(input.settings!==undefined&&resource.kind!=='local')throw new HttpError(501,'此资源连接的编辑仍在迁移中');
  if(input.ssh!==undefined&&resource.kind!=='ssh')throw new HttpError(400,'仅 SSH 资源接受 SSH 连接');
  const ssh=input.ssh===undefined?resource.ssh:this.ssh.prepare(input.ssh,resource.ssh,allowIncompleteSSH);
  return this.store.transaction(()=>{
   const changed=digest([settings,ssh])!==digest([resource.settings,resource.ssh]);
   const revision=(this.store.get<number>('resourceRevisions',resource.id)??1)+(changed?1:0);
   const complete=!ssh||!!(ssh.authMethod==='password'?ssh.credentialRef:ssh.identityFile);
   const next:Resource={...resource,name,description,settings,ssh,configurationRevision:revision,...(input.ssh!==undefined?{status:complete?'available' as const:'unavailable' as const}:{})};
   this.store.put('resourceRevisions',resource.id,revision);this.store.put('resources',resource.id,next);
   for(const node of this.store.catalog().resourceTree??[])if(node.resourceId===resource.id)this.store.put('tree',node.id,{...node,name});
   return next;
  });
 }
 /** Private reviewed-plan writes; never accepts raw request configurations. */
 applyImports(projectId:string,rows:PreparedResourceImport[],receipt:()=>void){
  this.security.resourceConfiguration(projectId);this.store.project(projectId);
  for(const row of rows){
   const resource=row.resource;
   if(resource.projectId!==projectId)throw new HttpError(403,'导入资源不属于此项目');
   this.security.resourceConfiguration(projectId,row.previous?resource.id:undefined);
   if(row.previous&&digest(this.store.require<Resource>('resources',resource.id))!==row.previous)throw new HttpError(409,'已有资源已变化，请重新预览');
   if(!row.previous&&this.store.get('resources',resource.id))throw new HttpError(409,'资源身份已存在，请重新预览');
   if(resource.kind==='ssh')this.ssh.configuration(resource.ssh,true);
   else this.services.validatePrepared(resource.kind,resource.settings??{});
  }
  return this.store.transaction(()=>{
   for(const row of rows){
    const resource=row.resource;
    const revision=(row.previous?this.store.get<number>('resourceRevisions',resource.id)??resource.configurationRevision??1:0)+1;
    this.store.put('resources',resource.id,{...resource,configurationRevision:revision});
    this.store.put('resourceRevisions',resource.id,revision);
    if(row.previous)continue;
    let parentId:string|null=null;
    for(const name of row.folder.split('/').filter(Boolean)){
     const nodes=this.store.catalog().resourceTree!.filter(node=>node.projectId===projectId),siblings=nodes.filter(node=>node.parentId===parentId);
     const matches=siblings.filter(node=>node.kind==='folder'&&node.name===name);
     if(matches.length>1)throw new HttpError(409,'目标目录名称重复，请先整理目录');
     if(matches.length)parentId=matches[0].id;
     else{
      if(nodes.length>=10000)throw new HttpError(413,'资源目录达到上限');
      const folder:ResourceTreeNode={id:id(),projectId,parentId,name,kind:'folder',resourceId:null,position:Math.max(-1,...siblings.map(node=>node.position))+1};
      this.store.put('tree',folder.id,folder);parentId=folder.id;
     }
    }
    this.navigation.attach(resource,parentId);
   }
   receipt();
  });
 }
}
