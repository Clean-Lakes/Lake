import {useEffect,useState} from 'react';
import {Glyph} from './Icons';
import './userMessageCopy.css';

export function UserMessageCopy({text}:{text:string}){
 const [state,setState]=useState<'idle'|'copied'|'error'>('idle');
 useEffect(()=>setState('idle'),[text]);
 useEffect(()=>{
  if(state!=='copied')return;
  const timer=setTimeout(()=>setState('idle'),2000);
  return()=>clearTimeout(timer);
 },[state]);
 async function copy(){
  try{await navigator.clipboard.writeText(text);setState('copied');}
  catch{setState('error');}
 }
 const feedback=state==='copied'?'已复制消息':state==='error'?'复制失败，请选中文字后手动复制。':'';
 return <span className="user-message-actions" data-state={state}>
  <button type="button" className="user-message-copy" aria-label="复制消息" title={feedback||'复制消息'} onClick={()=>void copy()}><Glyph name={state==='copied'?'check':state==='error'?'alert':'copy'} size={16}/></button>
  <span className="visually-hidden" role={state==='error'?'alert':'status'}>{feedback}</span>
 </span>;
}
