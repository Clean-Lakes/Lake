// Real memory wrapper, synthetic API only. No model, credentials or host I/O.
import {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {ProjectMemory} from '../../src/ProjectMemory';
import '../../src/styles.css';
import '../../src/appSelect.css';
import '../../src/surfaceGeometry.css';
import '../../src/theme.css';
const query=new URLSearchParams(location.search);
const version=Number(query.get('version')||1);
document.documentElement.dataset.theme=query.get('theme')||'light';
const settings={memorySchemaVersion:version,projectId:'memory-fixture',useEnabled:true,extractionEnabled:true,epoch:0,revision:0,settingsRevision:0,publishedRevision:0};
const calls:string[]=[];
window.fetch=async(input)=>{
 const path=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url,location.href).pathname;
 calls.push(path);
 document.documentElement.dataset.apiCalls=JSON.stringify(calls);
 const respond=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
 if(path.endsWith('/memory-settings'))return respond(settings);
 if(path.endsWith('/memory'))return respond({settings,items:[],total:0,projectRevision:0});
 if(path.endsWith('/memory-jobs'))return respond({items:[{jobId:'retired-job',status:'blocked',attempts:3,lastErrorCode:'memory_v2_retired',usageJSON:'{}',createdAt:'2026-11-04T00:00:00Z'}]});
 return respond({error:'Unexpected API in retirement fixture'},410);
};
function Preview(){const [open,setOpen]=useState(true);return <main><button className="button secondary" onClick={()=>setOpen(true)}>打开记忆</button>{open&&<ProjectMemory project={{id:'memory-fixture',name:'记忆退役验收',createdAt:''}} onClose={()=>setOpen(false)}/>}</main>}
createRoot(document.getElementById('root')!).render(<Preview/>);
