import {useEffect,useRef,useState} from 'react';
import type {ConversationReadState} from '../../shared/contracts';
import {api,readableError} from './api';
import {Glyph} from './Icons';

declare global {interface Window {lakeWindowAttention?:{isReading:()=>Promise<boolean>};}}

/** A route selection alone is not a read. Acknowledge the cursor delivered
 * with rendered content only after its end is visible in a foreground window. */
export function ConversationReadMarker({session,state,enabled=true}:{session:string;state?:ConversationReadState;enabled?:boolean}) {
 const marker=useRef<HTMLSpanElement>(null);
 useEffect(()=>{
  const element=marker.current,cursor=state?.cursor;
  if(!element||!enabled||!cursor||cursor<=(state?.seenCursor??'')||typeof IntersectionObserver==='undefined')return;
  let disposed=false,visible=false,pending=false,saved=false;
  const acknowledge=async()=>{
   if(disposed||!visible||document.hidden||!document.hasFocus()||pending||saved)return;
   pending=true;
   try{
    const attention=window.lakeWindowAttention?await window.lakeWindowAttention.isReading():true;
    if(!attention||disposed||!visible||document.hidden||!document.hasFocus())return;
    await api.readConversation(session,cursor);saved=true;if(!disposed)window.dispatchEvent(new Event('lake:conversation-read'));
   }
   catch{/* Retain the unread dot; retry while this content remains visible. */}
   finally{pending=false;}
  };
  const observer=new IntersectionObserver(entries=>{visible=entries.some(entry=>entry.isIntersecting);void acknowledge();},{root:element.closest('.conversation'),threshold:1});
  observer.observe(element);
  document.addEventListener('visibilitychange',acknowledge);
  window.addEventListener('focus',acknowledge);
  const retry=window.setInterval(()=>void acknowledge(),2500);
  return()=>{disposed=true;observer.disconnect();document.removeEventListener('visibilitychange',acknowledge);window.removeEventListener('focus',acknowledge);window.clearInterval(retry);};
 },[session,state?.cursor,state?.seenCursor,enabled]);
 return <span ref={marker} className="conversation-read-marker" aria-hidden="true" style={{display:'block',height:1,width:1}}/>;
}

export const hasUnreadMessages=(state:ConversationReadState|undefined)=>!!state?.cursor&&state.cursor>state.seenCursor;

/** Explicit acknowledgement is independent of scrolling. A delayed response can
 * only acknowledge the exact cursor clicked, never newer content or a sibling. */
export function ConversationReadButton({session,state,disabled=false}:{session:string;state?:ConversationReadState;disabled?:boolean}){
 const [saved,setSaved]=useState<{session:string;cursor:string}>(),[pending,setPending]=useState(false),[error,setError]=useState('');
 const current=useRef(session);current.current=session;
 const seen=saved?.session===session&&saved.cursor>(state?.seenCursor??'')?saved.cursor:state?.seenCursor??'';
 useEffect(()=>{setError('');},[session,state?.cursor]);
 if(!state?.cursor||state.cursor<=seen)return null;
 const acknowledge=async()=>{
  if(pending||disabled)return;
  const target=session,cursor=state.cursor;setPending(true);setError('');
  try{
   await api.readConversation(target,cursor);
   setSaved(previous=>previous?.session===target&&previous.cursor>cursor?previous:{session:target,cursor});
   window.dispatchEvent(new Event('lake:conversation-read'));
  }catch(cause){if(current.current===target)setError(readableError(cause));}
  finally{setPending(false);}
 };
 return <div className="conversation-read-action"><button type="button" className="button secondary" disabled={disabled||pending} onClick={()=>void acknowledge()} title="将这位专员当前的消息标记为已读"><Glyph name={pending?'loader':'check'} size={14}/>{pending?'标记中…':'标记已读'}</button>{error&&<span role="alert">{error}</span>}</div>;
}
