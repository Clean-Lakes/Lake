// Real application with fictional projects; no backend, host or model calls.
import './readme-workbench';
const params=new URLSearchParams(location.search);
document.documentElement.classList.toggle('lake-corner-fallback',params.has('corner-fallback'));
const development=!params.has('release');
document.documentElement.classList.toggle('lake-development',development);
// Match the native clients' later-injected rule to verify shared CSS wins.
const badge=document.createElement('style');
badge.textContent='.lake-development .brand::after { content: "DEV"; font: 600 10px system-ui; padding: 3px 5px; border: 1px solid var(--border); border-radius: 4px; color: var(--text-secondary); }';
document.head.appendChild(badge);
window.lakeDesktopUpdates={...window.lakeDesktopUpdates!,development};
const original=window.fetch.bind(window);
window.fetch=async(input,init)=>{
 const result=await original(input,init);
 const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url,location.href);
 if(url.pathname!=='/api/catalog')return result;
 const catalog=await result.json();
 catalog.projects[0].name=params.has('long')?'HexHub 服务器 · 跨区域容灾与生产环境资源管理':'HexHub 服务器';
 catalog.projects.push({id:'workspace-demo',name:'本地开发',createdAt:'2026-10-20T00:00:00Z'});
 return new Response(JSON.stringify(catalog),{headers:{'Content-Type':'application/json'}});
};
// Native sidebar wheel proof; contains no user data or synthetic input scaling.
if(params.has('wheel-proof')){
 const proof=document.createElement('output');proof.dataset.testid='sidebar-wheel-proof';proof.hidden=true;document.body.appendChild(proof);
 const samples:Array<{delta:number;mode:number;prevented:boolean;before:number;after:number}>=[];
 document.addEventListener('wheel',event=>{
  const nav=document.querySelector('.project-scroll');if(!nav||!nav.contains(event.target as Node))return;
  const sample={delta:event.deltaY,mode:event.deltaMode,prevented:event.defaultPrevented,before:nav.scrollTop,after:nav.scrollTop};samples.push(sample);
  requestAnimationFrame(()=>{sample.prevented=event.defaultPrevented;sample.after=nav.scrollTop;proof.textContent=JSON.stringify(samples);});
 },{capture:true,passive:true});
}
