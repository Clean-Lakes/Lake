// README presentation: current App, fictional records and a standard macOS window frame.
// This frame avoids screen-sharing overlays in native automation captures; it is not a native OS capture.
import './readme-workbench';
import './readme-macos.css';
const bodies:Record<string,string>={
 observed:'异常集中在新版本的上游超时，旧版本节点正常。',
 'rolled-back':'已回滚到 v2.8.0，三个实例均已就绪。',
 verified:'复测通过，错误率从 3.8% 降到 0.06%。',
 finished:'服务已恢复，根因尚未确认；保留样本继续分析。',
};
const previous=window.fetch.bind(window);
window.fetch=async(input,init)=>{
 const response=await previous(input,init);
 const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url,location.href);
 if(url.pathname.endsWith('/ai/reasoning'))return new Response(JSON.stringify({modelId:'deepseek-chat',effort:'',default:'medium',levels:['low','medium','high']}),{headers:{'Content-Type':'application/json'}});
 if(!response.ok||!url.pathname.endsWith('/snapshot')&&!url.pathname.endsWith('/sre/tasks'))return response;
 const value=await response.json();
 const tasks=value.sre?.tasks??value.items??[];
 for(const task of tasks)task.messages=task.messages.filter((message:{id:string})=>message.id!=='plan').map((message:{id:string;body:string})=>({...message,body:bodies[message.id]??message.body}));
 return new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json'}});
};
