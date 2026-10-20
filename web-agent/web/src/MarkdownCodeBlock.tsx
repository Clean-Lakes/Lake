import {Children,cloneElement,isValidElement,useEffect,useRef,useState,type ComponentPropsWithoutRef,type ReactNode} from 'react';
import type {ExtraProps} from 'react-markdown';
import {Glyph} from './Icons';

// A single shell command uses the compact command/arguments colors. Keep every
// original character as a text node so copying never changes the command.
function commandColors(children:ReactNode){
 return Children.map(children,child=>{
  if(!isValidElement<{className?:string;children?:ReactNode}>(child))return child;
  const {className='',children:text}=child.props;
  if(child.type!=='code'||typeof text!=='string'||!/(?:^|\s)language-(?:bash|sh|shell|zsh|bat|cmd|dos|powershell|ps1)(?:\s|$)/i.test(className))return child;
  const line=text.match(/^([ \t]*)([^\s]+)([^\r\n]*)(\r?\n)?$/);
  if(!line||line[2]!.startsWith('#'))return child;
  return cloneElement(child,{className:className+' markdown-code-shell'},line[1],<span className="markdown-code-command">{line[2]}</span>,line[3],line[4]);
 });
}

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
  <pre {...props} ref={pre}>{commandColors(children)}</pre>
  <div className="markdown-code-toolbar"><button type="button" aria-label="复制代码" title={state==='copied'?'已复制':'复制整段代码'} onClick={()=>void copy()}><Glyph name={state==='copied'?'check':'copy'} size={18}/></button><span className="visually-hidden" role="status">{state==='copied'?'已复制代码':''}</span></div>
  {state==='error'&&<p className="markdown-code-error" role="alert">复制失败，请选中代码后使用键盘快捷键复制。</p>}
 </div>;
}
