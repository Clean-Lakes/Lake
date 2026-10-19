import {useState,type ReactNode} from 'react';
import type {AIApproval} from '../../shared/contracts';
import {Glyph} from './Icons';
import {DisclosureSummary} from './DisclosureSummary';

export function OperationApproval({approval:p,title,note,description,args,agentName,confirmation,onConfirmation,busy,error,remaining=0,onDecide,children}:{
 approval:AIApproval;title:string;note:string;description:string;args:unknown;agentName?:string;
 confirmation:string;onConfirmation:(value:string)=>void;busy:boolean;error:string;remaining?:number;
 onDecide:(accept:boolean)=>void;children?:ReactNode;
}){
 const [technical,setTechnical]=useState(false);
 const selecting=p.kind==='resource_select',opening=p.kind==='terminal_open';
 const fields=args&&typeof args==='object'?args as Record<string,unknown>:{};
 const command=typeof fields.command==='string'?fields.command:typeof fields.sql==='string'?fields.sql:undefined;
 const accept=selecting?p.needsTerminal?'使用此资源并创建终端':'使用此资源':opening?'允许创建并继续':'确认并继续';
 return <section className="attachment-approval operation-approval" aria-label="Agent 操作确认">
  <header><Glyph name="lakeConfirm" size={18}/><div><strong>{title}</strong><p>{agentName?`${agentName} · `:''}仅限本次操作</p></div><span>{p.risk==='dangerous'?'高风险 · 等待确认':'等待确认'}</span></header>
  <dl className="attachment-approval-destination"><div><dt>目标</dt><dd><strong>{p.target}</strong></dd></div>{selecting&&p.needsTerminal&&<div><dt>终端</dt><dd>为此资源创建终端后继续</dd></div>}</dl>
  <p className="operation-approval-description">{selecting?'本次操作将使用以上资源。若目标不符，可拒绝后在会话配置中更换。':description}</p>
  {command&&<div className="operation-approval-command"><span>{typeof fields.sql==='string'?'完整 SQL':'完整命令'}</span><pre>{command}</pre></div>}
  {note&&<p className="operation-approval-description">{note}</p>}
  {children}
  <details className="attachment-approval-details" onToggle={event=>setTechnical(event.currentTarget.open)}><DisclosureSummary>技术参数</DisclosureSummary>{technical&&<pre>{JSON.stringify({tool:p.call.name,resourceId:p.resourceId,terminalId:p.terminalId,arguments:args},null,2)}</pre>}</details>
  {p.confirmation&&<label className="attachment-approval-confirmation">请输入“{p.confirmation}”确认目标<input value={confirmation} onChange={event=>onConfirmation(event.target.value)} autoComplete="off"/></label>}
  {error&&<p className="attachment-approval-error" role="alert">{error}</p>}
  <footer><small>{remaining>1?`${remaining} 项操作待确认 · 尚未执行`:'尚未执行'}</small><div><button type="button" className="button secondary" disabled={busy} onClick={()=>onDecide(false)}>拒绝</button><button type="button" className="button primary" disabled={busy||!!p.confirmation&&confirmation!==p.confirmation} onClick={()=>onDecide(true)}>{busy?'处理中…':accept}</button></div></footer>
 </section>;
}
