// Synthetic approval UI only. Decisions are captured in memory, never dispatched.
import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {AIPending} from '../../src/AIPanel';
import type {AIView} from '../../../shared/contracts';
import '../../src/theme.css';
import '../../src/styles.css';
import '../../src/sreCollaboration.css';
import '../../src/assistantProse.css';
import '../../src/fileOperationApproval.css';
import '../../src/operationApproval.css';
const params=new URLSearchParams(location.search);
document.documentElement.dataset.theme=params.get('theme')==='dark'?'dark':'light';
const file={sourceId:'file-synthetic-upload',name:'系统信息.xlsx',sizeBytes:12066};
const view={status:'waiting_approval',pending:{id:'synthetic-approval',kind:'file_write',risk:'write',target:'京东云服务器 · 36.151.150.63',resourceId:'synthetic-resource',fingerprint:'synthetic',...(params.has('confirm')?{confirmation:'执行 测试服务器'}:{}),call:{id:'synthetic-call',name:'stage_attachment',arguments:JSON.stringify({source_id:file.sourceId,asset_ref:'synthetic-asset',runtime:'ssh',path:'/root/系统信息.xlsx',...(params.has('overwrite')?{overwrite:true}:{})})}}} as AIView;
if(params.has('write')){
 const content='# 数据库迁移方案\n\n先完成只读检查与备份验证，再进入迁移窗口。\n\n## 执行安排\n\n| 阶段 | 工作 | 验证 |\n| --- | --- | --- |\n| 准备 | 核对资源与备份 | 清单完整 |\n| 演练 | 在隔离环境验证 | 结果一致 |\n| 切换 | 按确认后的步骤执行 | 服务可用 |\n\n## 检查清单\n\n- 确认目标实例与连接方式\n- 记录当前配置和回退点\n- 完成备份恢复演练\n\n```sh\nprintf "演示命令，仅作为方案内容展示\\n"\n```\n\n'+('本段为隔离界面的演示方案，不调用模型、不访问主机。\n\n').repeat(8);
 view.pending={id:'synthetic-file-approval',kind:'file_write',risk:'write',target:'Local machine',resourceId:'synthetic-local',fingerprint:'synthetic',...(params.has('confirm')?{confirmation:'执行 Local machine'}:{}),call:{id:'synthetic-file-call',name:'write',arguments:JSON.stringify({path:'/Users/demo/Desktop/数据库迁移方案.md',runtime:'local',asset_ref:'synthetic-local-alias',content})},preview:{before:'# 数据库迁移方案\n\n待完善。\n',after:content}};
 if(params.has('queue'))view.pendingApprovals=[view.pending,view.pending];
}
if(params.has('target'))view.pending={id:'synthetic-target-approval',kind:'resource_select',risk:'readonly',target:'演示服务器 · 192.0.2.14',resourceId:'synthetic-target-resource',needsTerminal:true,fingerprint:'synthetic',...(params.has('confirm')?{risk:'dangerous',confirmation:'执行 演示服务器'}:{}),call:{id:'synthetic-target-call',name:'inspect_host',arguments:JSON.stringify({asset_ref:'synthetic-asset',runtime:'ssh'})}};
if(params.has('target')&&params.has('queue'))view.pendingApprovals=[view.pending!,view.pending!];
const originalFetch=window.fetch.bind(window);
window.fetch=async(input,init)=>{
 const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url,location.href);
 if(url.pathname.startsWith('/api/')) {
  if(url.pathname.startsWith('/api/sessions/upload-ui/ai/')) {
   window.dispatchEvent(new CustomEvent('fixture-decision',{detail:{path:url.pathname,...JSON.parse(String(init?.body))}}));
   return new Response('{}',{status:200,headers:{'Content-Type':'application/json'}});
  }
  return new Response('{}',{status:403,headers:{'Content-Type':'application/json'}});
 }
 return originalFetch(input,init);
};
function Fixture(){
 const [decision,setDecision]=useState('');
 React.useEffect(()=>{const handle=(event:Event)=>setDecision(JSON.stringify((event as CustomEvent).detail));window.addEventListener('fixture-decision',handle);return()=>window.removeEventListener('fixture-decision',handle)},[]);
 return <main style={{maxWidth:params.has('write')?860:700,padding:20,margin:'24px auto'}}><p style={{fontSize:12,color:'var(--text-muted)',marginBottom:18}}>{params.has('target')?'目标资源确认':params.has('write')?'文件操作确认':'附件上传确认'} · 隔离界面验收</p><AIPending session="upload-ui" attachments={[file]} view={view} {...(params.has('child')?{runId:'synthetic-child',agentName:'调查员'}:{})} refresh={async()=>{}}/>{decision&&<output aria-label="测试决策记录" style={{display:'block',overflowWrap:'anywhere',fontSize:12}}>{decision}</output>}</main>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
