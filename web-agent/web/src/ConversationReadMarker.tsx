import {useEffect,useRef} from 'react';
import type {ConversationReadState} from '../../shared/contracts';
import {api} from './api';

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
   try{await api.readConversation(session,cursor);saved=true;if(!disposed)window.dispatchEvent(new Event('lake:conversation-read'));}
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
