import {Glyph} from './Icons';
import {useEffect, useState} from "react";
import type {AIQuestionRequest} from "../../shared/contracts";
import {api, readableError} from "./api";
import {chooseAnswer, questionAnswer, questionOptions, recordQuestionAnswer} from "./questionState";
export function AgentQuestion({session, request, refresh,runId}: {runId?:string;session: string; request: AIQuestionRequest; refresh: () => Promise<unknown>}) {
 const [selected,setSelected]=useState<Record<string,string[]>>({});
 const [text,setText]=useState<Record<string,string>>({});
 const [other,setOther]=useState<Record<string,boolean>>({});
 const [committed,setCommitted]=useState<Record<string,string[]>>({});
 const [index,setIndex]=useState(0);const [collapsed,setCollapsed]=useState(false);
 const [busy,setBusy]=useState(false);const [error,setError]=useState("");
 useEffect(()=>{setSelected({});setText({});setOther({});setCommitted({});setIndex(0);setCollapsed(false);setBusy(false);setError("");},[request.id]);
 const question=request.questions[index];if(!question)return null;
 const options=questionOptions(question);
 const custom=other[question.id]||options.length===0;
 const values=questionAnswer(question,selected[question.id]||[],text[question.id]||"",custom);
 const last=index===request.questions.length-1;
 const submit=async(answers:Record<string,string[]>)=>{setBusy(true);setError("");try{
  await api.aiOperation(session,runId?"agentQuestionReply":"questionReply",{id:request.id,answers,...(runId?{runId}:{})});await refresh();
 }catch(error){setError(readableError(error));setBusy(false);}};
 const advance=(skip=false)=>{
  if(busy||!skip&&!values.length)return;
  const next=recordQuestionAnswer(committed,question.id,skip?[]:values);setCommitted(next);
  if(skip){setSelected(v=>({...v,[question.id]:[]}));setText(v=>({...v,[question.id]:""}));setOther(v=>({...v,[question.id]:false}));}
  if(last)void submit(next);else setIndex(index+1);
 };
 return <section className="lake-question" aria-label="Agent 问题" onKeyDown={event=>{
  if((event.metaKey||event.ctrlKey)&&event.key==="Enter"&&!event.nativeEvent.isComposing){event.preventDefault();advance();}
 }}>
 <header className="lake-question-heading"><span className="lake-question-count">{index+1}/{request.questions.length}</span>
 <strong>{question.title}{question.multi_select?<small>（可多选）</small>:null}</strong>
 <button type="button" aria-label={collapsed?"展开问题":"收起问题"} aria-expanded={!collapsed} onClick={()=>setCollapsed(!collapsed)}><Glyph name="chevron" size={14} className={collapsed?"is-collapsed":""}/></button>
 <button type="button" aria-label="暂不回答剩余问题，继续任务" disabled={busy} onClick={()=>void submit(committed)}><Glyph name="close" size={14}/></button></header>
 {!collapsed&&<><fieldset disabled={busy}><legend className="visually-hidden">{question.title}</legend>
 {question.reason&&<p className="lake-question-reason">{question.reason}</p>}
 {options.map(option=>{
  const checked=(selected[question.id]||[]).includes(option.label)&&(!custom||question.multi_select);
  return <label className={`lake-question-option ${checked?"is-selected":""}`} key={option.label}>
   <span><strong>{option.label}</strong>{option.recommended&&<em>推荐</em>}{option.description&&<small>{option.description}</small>}</span>
   <input type={question.multi_select?"checkbox":"radio"} name={`question-${request.id}-${question.id}`} checked={checked} onChange={()=>{
    setSelected(v=>({...v,[question.id]:chooseAnswer(question,v[question.id]||[],option.label)}));
    if(!question.multi_select)setOther(v=>({...v,[question.id]:false}));
   }}/></label>;
 })}
 <div className={`lake-question-other ${custom?"is-selected":""}`}>
  {options.length>0&&<label className="lake-question-option"><span><strong>其他 / 补充</strong></span>
   <input type={question.multi_select?"checkbox":"radio"} name={`question-${request.id}-${question.id}`} checked={custom} onChange={()=>setOther(v=>({...v,[question.id]:question.multi_select?!custom:true}))}/></label>}
  <textarea aria-label={`${question.title}：自行填写`} maxLength={4000} value={text[question.id]||""} placeholder="填写你的选择或补充信息" onFocus={()=>setOther(v=>({...v,[question.id]:true}))} onChange={e=>{setText(v=>({...v,[question.id]:e.target.value}));setOther(v=>({...v,[question.id]:true}));}}/>
 </div></fieldset>
 {error&&<p role="alert">{error}</p>}
 <footer className="lake-question-footer">{index>0&&<button type="button" disabled={busy} onClick={()=>setIndex(index-1)}>上一题</button>}
 <span/>
 <button type="button" disabled={busy} onClick={()=>advance(true)}>跳过</button>
 <button type="button" className="lake-question-next" disabled={busy||!values.length} onClick={()=>advance()}>{busy?"提交中…":last?"提交并继续":"下一题"}<kbd>⌘ / Ctrl ↵</kbd></button>
 </footer></>}
 </section>;
}
