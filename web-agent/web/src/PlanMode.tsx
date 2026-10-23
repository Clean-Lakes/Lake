import {useRef,useState} from 'react';
import type {ConversationMode} from '../../shared/contracts';
import {Glyph} from './Icons';
import {readableError} from './api';

export function planSlashCommand(text:string):{prompt:string}|null {
 const match=text.trim().match(/^\/plan(?:\s+([\s\S]*))?$/);
 return match?{prompt:match[1]?.trim()??''}:null;
}

export function planComposerDraft<T extends {position:number}>(draft:string,references:T[]) {
 const command=planSlashCommand(draft);
 const prefixLength=command?.prompt?draft.indexOf(command.prompt):0;
 return {command,text:command?.prompt||draft,references:prefixLength?references.filter(ref=>ref.position>=prefixLength).map(ref=>({...ref,position:ref.position-prefixLength})):references};
}

// Keep persisted assistant history lossless; the protocol tags are presentation
// metadata, never user-facing Markdown or authority to execute by themselves.
export function planMarkdown(text:string):string {
 let fence='';
 return text.split('\n').filter(line=>{
  const trimmed=line.trim();
  if(fence){if(trimmed.startsWith(fence)&&new RegExp(`^${fence[0]}+[ \\t\\r]*$`).test(trimmed))fence='';return true;}
  const marker=trimmed.match(/^(`{3,}|~{3,})/);
  if(marker){fence=marker[0];return true;}
  return trimmed!=='<proposed_plan>'&&trimmed!=='</proposed_plan>';
 }).join('\n');
}

export function PlanModeToggle({mode='default',disabled=false,disabledReason,onChange}:{mode?:ConversationMode;disabled?:boolean;disabledReason?:string;onChange:(mode:ConversationMode)=>Promise<unknown>}) {
 const saving=useRef(false);
 const [busy,setBusy]=useState(false),[error,setError]=useState('');
 const enabled=mode==='plan';
 const hint=disabled?disabledReason||'本轮运行或有待发送消息，结束后可切换模式。':enabled?'Plan 模式：只读调查、澄清需求并制定方案。点击退出，或输入 /plan。':'开启 Plan 模式，先制定方案再执行。也可输入 /plan。';
 return <><button type="button" className="composer-permission-button plan-mode-toggle" aria-label="Plan 模式" aria-pressed={enabled} aria-busy={busy} disabled={disabled||busy} title={hint} onClick={()=>{
  if(saving.current||disabled)return;saving.current=true;setBusy(true);setError('');
  void onChange(enabled?'default':'plan').catch(error=>setError(readableError(error))).finally(()=>{saving.current=false;setBusy(false);});
 }}><Glyph name="document" size={14}/><span>Plan</span></button>{error&&<span className="plan-mode-error" role="alert">{error}</span>}</>;
}

export function PlanActions({disabled=false,onExecute,onRevise}:{disabled?:boolean;onExecute:()=>Promise<unknown>;onRevise:()=>void}) {
 const sending=useRef(false);
 const [busy,setBusy]=useState(false),[error,setError]=useState('');
 return <section className="plan-actions" aria-label="计划操作">
  <p><Glyph name="document" size={15}/>计划已就绪，可继续修改或开始执行。</p>
  <div className="plan-actions-buttons"><button type="button" className="button secondary" disabled={disabled||busy} onClick={onRevise}><Glyph name="edit" size={14}/>修改计划</button><button type="button" className="button primary" disabled={disabled||busy} aria-busy={busy} onClick={()=>{
   if(sending.current||disabled)return;sending.current=true;setBusy(true);setError('');
   void onExecute().catch(error=>setError(readableError(error))).finally(()=>{sending.current=false;setBusy(false);});
  }}><Glyph name="arrow" size={14}/>{busy?'正在开始…':'执行计划'}</button></div>
  {error&&<p className="plan-mode-error" role="alert">{error}</p>}
 </section>;
}

export function PlanReference({state,onOpen}:{state:'saved'|'writing'|'incomplete';onOpen?:()=>void}) {
 return <section className="plan-reference" aria-label="计划状态"><Glyph name="document" size={17}/><span>{state==='saved'?'计划已保存':state==='writing'?'正在生成计划…':'计划未完成'}</span>{onOpen&&<button type="button" onClick={onOpen}>查看计划列表<Glyph name="next" size={13}/></button>}</section>;
}
