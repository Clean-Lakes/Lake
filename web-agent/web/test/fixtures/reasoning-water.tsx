// Real selector with fictional in-memory settings; never contacts a model or backend.
import {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {ReasoningSelector} from '../../src/ReasoningSelector';
import type {ReasoningSettings} from '../../../shared/contracts';
import '../../src/styles.css';
import '../../src/appSelect.css';
import '../../src/composerModelSelect.css';
document.documentElement.dataset.theme=new URLSearchParams(location.search).get('theme')||'light';
const levels=['none','minimal','low','medium','high','xhigh','max','ultra'];
const settings=new Map<string,ReasoningSettings>();
for(const [id,effort] of [['main',''],['low','low'],['medium','medium'],['high','high'],['max','max'],['unknown','']])settings.set(id,{modelId:'fixture-model',effort,levels,default:id==='unknown'?undefined:'medium'});
window.fetch=async(input,init)=>{
 const path=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url,location.href).pathname;
 const match=path.match(/^\/api\/sessions\/([^/]+)\/ai\/reasoning$/);
 if(!match||!settings.has(match[1]!))return new Response('{}',{status:404});
 const value=settings.get(match[1]!)!;
 if(init?.method==='POST'){const body=JSON.parse(String(init.body));if(body.modelId!==value.modelId||body.effort!==''&&!levels.includes(body.effort))return new Response('{}',{status:400});value.effort=body.effort;}
 return new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json'}});
};
function Fixture(){
 const [disabled,setDisabled]=useState(false);
 const selector=(id:string)=><ReasoningSelector session={id} modelId="fixture-model" disabled={disabled} disabledReason="本轮运行中，结束后可调整思考级别。" onSaving={()=>{}}/>;
 return <main style={{maxWidth:720,margin:'40px auto',padding:24}}>
  <div className="composer"><div className="composer-input"><div className="composer-body"><textarea aria-label="给 Lake 的消息" placeholder="想让 Lake 帮你做什么？"/></div></div><div className="composer-foot"><span>Lake</span><div className="composer-status">{selector('main')}</div></div></div>
  <div style={{display:'flex',flexWrap:'wrap',justifyContent:'space-between',gap:12,marginTop:40}}>{['low','medium','high','max'].map(id=><div key={id}>{selector(id)}</div>)}</div>
  <div style={{display:'flex',gap:16,alignItems:'center',marginTop:32,fontSize:12}}><label><input type="checkbox" checked={disabled} onChange={event=>setDisabled(event.target.checked)}/> 模拟运行中</label><span>未知默认</span>{selector('unknown')}</div>
 </main>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
