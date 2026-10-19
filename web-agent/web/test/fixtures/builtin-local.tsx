// Real App integration; fictional in-memory API, no backend or host execution.
import './readme-workbench';
const previousFetch=window.fetch.bind(window);
window.fetch=async(input,init)=>{
 const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url,location.href);
 const response=await previousFetch(input,init);
 if((init?.method??'GET')==='GET'&&(url.pathname==='/api/catalog'||url.pathname.endsWith('/snapshot'))){
  const value=await response.json();
  value.resources.unshift({id:'builtin-local',projectId:'demo-project',kind:'local',name:'Local machine',description:'Built-in local terminal',status:'available',settings:{shell:'sh'}});
  // A legacy nested node is projected back to the fixed root position.
  value.resourceTree.push({id:'builtin-node',projectId:'demo-project',kind:'resource',resourceId:'builtin-local',name:'',parentId:'apps',position:99});
  return new Response(JSON.stringify(value),{status:response.status,headers:{'Content-Type':'application/json'}});
 }
 return response;
};
