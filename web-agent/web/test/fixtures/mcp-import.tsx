// Actual settings component with an in-memory API. No connections, commands,
// credential reads or writes to Lake homes are performed by this fixture.
import {createRoot} from 'react-dom/client';
import {MCPSettings} from '../../src/MCPSettings';
import {parseMCPJSON,validateMCPInput,type MCPInput} from '../../src/mcpConfig';
import '../../src/styles.css';
import '../../src/appSelect.css';
import '../../src/modelSettings.css';
const params=new URLSearchParams(location.search);
document.documentElement.dataset.theme=params.get('theme')||'light';
let rows:Array<MCPInput&{id:string}>=[];
let serial=0,imports=0,saves=0,tests=0;
const proof=document.createElement('output');proof.dataset.testid='mcp-request-proof';proof.className='visually-hidden';document.body.appendChild(proof);
const update=()=>{proof.textContent=JSON.stringify({imports,saves,tests,count:rows.length});};update();
const visible=(row:MCPInput&{id:string})=>{const {headers,env,...rest}=row;return {...rest,headersConfigured:!!headers&&!!Object.keys(headers).length,envConfigured:!!env&&!!Object.keys(env).length};};
const original=window.fetch.bind(window);
window.fetch=async(input,init)=>{
 const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url,location.href);
 if(!url.pathname.startsWith('/api/settings/mcp'))return original(input,init);
 const reply=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
 try{
  if(url.pathname==='/api/settings/mcp'&&(!init?.method||init.method==='GET'))return reply({servers:rows.map(visible)});
  if(url.pathname==='/api/settings/mcp/import'&&init?.method==='POST'){
   const parsed=parseMCPJSON(String(init.body));parsed.forEach(validateMCPInput);
   if(parsed.some(next=>rows.some(old=>old.name.toLowerCase()===next.name.toLowerCase())))return reply({error:'存在同名 MCP 服务，请修改名称后再导入'},400);
   const imported=parsed.map(row=>({...row,id:'fixture-'+(++serial)}));rows.push(...imported);imports++;update();return reply({servers:imported.map(visible)});
  }
  const id=url.pathname.split('/')[4];const old=rows.find(row=>row.id===id);
  if(!old)return reply({error:'服务不存在'},404);
  if(url.pathname.endsWith('/test')){tests++;update();return reply({serverId:id,serverName:old.name,count:0,tools:[]});}
  if(init?.method==='PUT'){
   const data=JSON.parse(String(init.body));const next={...old,...data};validateMCPInput(next);rows=rows.map(row=>row.id===id?next:row);saves++;update();return reply(visible(next));
  }
  if(init?.method==='DELETE'){rows=rows.filter(row=>row.id!==id);update();return reply({ok:true});}
 }catch{return reply({error:'配置无效'},400);}
 return reply({error:'验收接口不支持此操作'},400);
};
document.body.style.display='grid';document.body.style.placeItems='center';
const root=document.getElementById('root')!;root.style.display='grid';root.style.placeItems='center';
createRoot(document.getElementById('root')!).render(<section className="model-settings-dialog modal" role="dialog" aria-label="设置"><div className="model-settings-tabs" role="tablist" aria-label="设置分类"><button id="mcp-settings-tab" role="tab" aria-selected="true">MCP</button></div><div className="model-settings-body"><MCPSettings onBusyChange={()=>{}}/></div></section>);
