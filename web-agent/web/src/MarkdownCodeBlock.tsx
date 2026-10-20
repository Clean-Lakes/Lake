import {useEffect,useRef,useState,type ComponentPropsWithoutRef} from 'react';
import type {ExtraProps} from 'react-markdown';
import {Glyph} from './Icons';

export function MarkdownCodeBlock({node,children,...props}:ComponentPropsWithoutRef<'pre'>&ExtraProps){
 const pre=useRef<HTMLPreElement>(null);
 const [state,setState]=useState<'idle'|'copied'|'error'>('idle');
 useEffect(()=>{
  if(state!=='copied')return;
  const timer=setTimeout(()=>setState('idle'),2000);
  return()=>clearTimeout(timer);
 },[state]);
 async function copy(){
  if(!pre.current)return;
  try{
   await navigator.clipboard.writeText(pre.current.textContent??'');
   setState('copied');
  }catch{setState('error');}
 }
 return <div className="markdown-code-block">
  <div className="markdown-code-toolbar"><button type="button" aria-label="复制代码" title="复制整段代码" onClick={()=>void copy()}><Glyph name={state==='copied'?'check':'copy'} size={14}/><span aria-live="polite">{state==='copied'?'已复制':'复制'}</span></button></div>
  <pre {...props} ref={pre}>{children}</pre>
  {state==='error'&&<p className="markdown-code-error" role="alert">复制失败，请选中代码后使用键盘快捷键复制。</p>}
 </div>;
}
