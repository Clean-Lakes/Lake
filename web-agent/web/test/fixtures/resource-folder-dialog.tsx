// Production App + ResourceTree. All changes stay in this fictional in-memory
// catalog; no backend, credentials or real resource operations are contacted.
import './readme-workbench';
import type {ResourceTreeNode} from '../../../shared/contracts';
const previous=window.fetch;
let nodes:ResourceTreeNode[]|undefined,failNext=false,holdNext=false,release:(()=>void)|undefined;
const requests:unknown[]=[];
Object.assign(window,{lakeFolderDialogQA:{requests,failNext(){failNext=true;},holdNext(){holdNext=true;},release(){release?.();}}});
window.fetch=async(input,init)=>{
 const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url,location.href);
 const json=(data:unknown,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}});
 if(url.pathname.endsWith('/resource-tree')&&init?.method==='POST'){
  const data=JSON.parse(String(init.body));requests.push(data);
  if(holdNext){holdNext=false;await new Promise<void>(resolve=>{release=resolve;});release=undefined;}
  if(failNext){failNext=false;return json({error:'演示保存失败，请重试'},503);}
  if(!nodes){const response=await previous('/api/catalog');nodes=(await response.json()).resourceTree;}
  if(data.operation==='create')nodes!.push({id:'fixture-created-'+requests.length,projectId:'demo-project',parentId:data.parentId??null,kind:'folder',name:data.name,resourceId:null,position:nodes!.length});
  else if(data.operation==='rename'){const node=nodes!.find(node=>node.id===data.nodeId);if(node)node.name=data.name;}
  else return json({error:'Fixture only creates or renames fictional folders'},400);
  return json({nodes});
 }
 const response=await previous(input,init);
 if(url.pathname==='/api/catalog'||url.pathname.endsWith('/snapshot')){
  const data=await response.json();nodes??=data.resourceTree;data.resourceTree=nodes;return json(data,response.status);
 }
 return response;
};
