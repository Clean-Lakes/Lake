import type {Resource} from '../../web-agent/shared/contracts';
import {LakeStore,HttpError,id} from './store';
import {digest,text} from './tasks';
import type {LakeSecurity} from './security';
import type {LakeSSH} from './ssh';
import {LakeServiceResources,isServiceKind} from './service-resources';
import {LakeResourceNavigation} from './resource-navigation';

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
}
