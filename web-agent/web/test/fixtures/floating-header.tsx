// Real App with fictional data; no backend, model, credentials or host operations.
import './readme-workbench';
import '../../src/conversationDirectory.css';
import '../../src/windowsChrome.css';
const params=new URLSearchParams(location.search);
if(params.has('windows'))document.documentElement.classList.add('lake-windows-chrome');
if(params.has('classic')){
  const style=document.createElement('style');
  style.textContent='.conversation { scrollbar-width:auto; } .conversation::-webkit-scrollbar { width:14px; }';
  document.head.appendChild(style);
}
const previousFetch=window.fetch.bind(window);
window.fetch=async(input,init)=>{
  const response=await previousFetch(input,init);
  const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url,location.href);
  if(url.pathname!=='/api/catalog'&&!url.pathname.endsWith('/snapshot'))return response;
  const value=await response.json();
  if(params.has('long')){
    const title='服务运行状态异常排查，核对当前资源、历史证据以及部署和恢复记录'.repeat(3);
    for(const session of value.sessions??[])session.title=title;
    if(value.session)value.session.title=title;
  }
  if(value.ai&&params.has('scroll')){
    value.ai.cards=Array.from({length:18},(_,i)=>({id:`header-scroll-${i}`,type:'message',status:'completed',at:'2026-10-18T10:00:00Z',content:`第 ${i+1} 段：这是隔离滚动验证。标题气泡独立悬浮，正文继续经过顶部空间，完整会话记录保留。`}));
    value.ai.totalCards=value.ai.cards.length;
  }
  return new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json'}});
};
