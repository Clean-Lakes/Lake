import {useState} from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {diffLines} from 'diff';
import type {AIApproval} from '../../shared/contracts';
import {Glyph} from './Icons';
import {DisclosureSummary} from './DisclosureSummary';

const operations:Record<string,{title:string;accept:string;effect:string}>={
 write:{title:'写入文件',accept:'允许写入',effect:'将保存预览中的完整内容。'},
 write_file:{title:'写入文件',accept:'允许写入',effect:'将保存预览中的完整内容。'},
 append:{title:'追加内容',accept:'允许追加',effect:'向文件末尾追加内容。'},
 edit:{title:'修改文件',accept:'允许修改',effect:'仅修改本次指定的内容。'},
 edit_file:{title:'修改文件',accept:'允许修改',effect:'仅修改本次指定的内容。'},
 multi_edit:{title:'修改文件',accept:'允许修改',effect:'仅修改本次指定的内容。'},
 delete:{title:'删除文件',accept:'删除文件',effect:'将删除下方文件，请核对完整路径。'},
 read:{title:'读取文件',accept:'允许读取',effect:'读取该文件内容。'},
 read_file:{title:'读取文件',accept:'允许读取',effect:'读取该文件内容。'},
};
export function fileApprovalInfo(approval:AIApproval){
 const operation=operations[approval.call.name];
 if(!operation||!['file_write','file_read','delete'].includes(approval.kind??''))return null;
 let args:Record<string,unknown>;
 try {args=JSON.parse(approval.call.arguments)}catch{return null}
 if(!args||typeof args!=='object'||Array.isArray(args))return null;
 const path=typeof args.path==='string'?args.path:typeof args.file_path==='string'?args.file_path:'';
 if(!path.trim())return null;
 const deleting=approval.call.name==='delete';
 const before=approval.preview?.before;
 const after=approval.preview?.after;
 const content=deleting?before:after??(['write','write_file','append'].includes(approval.call.name)&&typeof args.content==='string'?args.content:undefined);
 const stats=typeof before==='string'&&typeof after==='string'&&before.length+after.length<200000
  ?diffLines(before,after).reduce((stats,part)=>({added:stats.added+(part.added?part.count??0:0),removed:stats.removed+(part.removed?part.count??0:0)}),{added:0,removed:0}):undefined;
 return {operation,args,path,content,stats,deleting,markdown:/\.(md|markdown|mdown)$/i.test(path),container:args.runtime==='container'&&typeof args.container_id==='string'?args.container_id:undefined};
}

export function FileOperationApproval({approval,agentName,confirmation,onConfirmation,busy,error,remaining=0,onDecide}:{
 approval:AIApproval;agentName?:string;confirmation:string;onConfirmation:(value:string)=>void;
 busy:boolean;error:string;remaining?:number;onDecide:(accept:boolean)=>void;
}){
 const [source,setSource]=useState(false),[technical,setTechnical]=useState(false);
 const info=fileApprovalInfo(approval);
 if(!info)return null;
 const {operation,args,path,content,stats,deleting,markdown,container}=info;
 const name=path.replace(/\\/g,'/').split('/').filter(Boolean).at(-1)??path;
 return <section className="attachment-approval file-operation-approval" aria-label="文件操作确认">
  <header><Glyph name="lakeConfirm" size={18}/><div><strong>{operation.title}</strong><p>{agentName?`${agentName} · `:''}仅限本次操作</p></div><span>{approval.risk==='dangerous'?'高风险 · 等待确认':'等待确认'}</span></header>
  <div className="file-approval-name"><strong>{name}</strong>{stats&&<span aria-label={`新增 ${stats.added} 行，删除 ${stats.removed} 行`}><i>+{stats.added}</i><b>−{stats.removed}</b></span>}</div>
  <dl className="attachment-approval-destination"><div><dt>目标</dt><dd>{approval.target}</dd></div>{container&&<div><dt>容器</dt><dd>{container}</dd></div>}<div><dt>位置</dt><dd className="attachment-approval-path">{path}</dd></div></dl>
  {content!==undefined&&<details className="file-approval-preview">
   <DisclosureSummary className="file-approval-preview-head"><span>{deleting?'将删除的内容':approval.call.name==='append'&&!approval.preview?'追加内容预览':'内容预览'}</span><small>{content?content.split('\n').length:0} 行</small></DisclosureSummary>
   {markdown&&<div className="file-approval-preview-toolbar"><button type="button" aria-pressed={source} onClick={()=>setSource(value=>!value)}>{source?'阅读':'原文'}</button></div>}
   <div className="file-approval-content" role="region" aria-label="待确认的文件内容" tabIndex={0}>{markdown&&!source?<div className="ai-markdown assistant-prose"><Markdown remarkPlugins={[remarkGfm]} skipHtml components={{a:({children})=><span>{children}</span>,img:({alt})=><span>{alt||'图片'}</span>,table:({node,...props})=><div className="markdown-table-scroll"><table {...props}/></div>}}>{content||'（空文件）'}</Markdown></div>:<pre>{content||'（空文件）'}</pre>}</div>
  </details>}
  <p className={`attachment-approval-effect${deleting?' is-delete':''}`}><Glyph name={deleting?'alert':'shield'} size={14}/>{['write','write_file'].includes(approval.call.name)&&approval.preview?.before?'将替换文件现有内容，请核对变更。':operation.effect}</p>
  <details className="attachment-approval-details" onToggle={event=>setTechnical(event.currentTarget.open)}><DisclosureSummary>技术参数</DisclosureSummary>{technical&&<pre>{JSON.stringify({tool:approval.call.name,resourceId:approval.resourceId,terminalId:approval.terminalId,arguments:args},null,2)}</pre>}</details>
  {approval.confirmation&&<label className="attachment-approval-confirmation">请输入“{approval.confirmation}”确认目标<input value={confirmation} onChange={event=>onConfirmation(event.target.value)} autoComplete="off"/></label>}
  {error&&<p className="attachment-approval-error" role="alert">{error}</p>}
  <footer><small>{remaining>1?`${remaining} 项操作待确认 · 尚未执行`:'尚未执行'}</small><div><button type="button" className="button secondary" disabled={busy} onClick={()=>onDecide(false)}>拒绝</button><button type="button" className="button primary" disabled={busy||!!approval.confirmation&&confirmation!==approval.confirmation} onClick={()=>onDecide(true)}>{busy?'处理中…':operation.accept}</button></div></footer>
 </section>;
}
