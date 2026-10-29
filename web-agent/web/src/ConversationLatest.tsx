import {useLayoutEffect,useState,type RefObject} from 'react';
import {Glyph} from './Icons';
import './conversationLatest.css';

export function ConversationLatest({container,onJump}:{container:RefObject<HTMLElement|null>;onJump:()=>void}) {
 const [visible,setVisible]=useState(false);
 useLayoutEffect(()=>{
  const box=container.current;
  if(!box)return;
  let frame:number|null=null;
  const measure=()=>{frame=null;setVisible(box.scrollHeight-box.clientHeight-box.scrollTop>64);};
  const schedule=()=>{if(frame===null)frame=requestAnimationFrame(measure);};
  const resize=new ResizeObserver(schedule);
  resize.observe(box);
  let content=box.firstElementChild;
  if(content)resize.observe(content);
  const children=new MutationObserver(()=>{
   if(content!==box.firstElementChild){
    if(content)resize.unobserve(content);
    content=box.firstElementChild;
    if(content)resize.observe(content);
   }
   schedule();
  });
  children.observe(box,{childList:true});
  box.addEventListener('scroll',schedule,{passive:true});
  schedule();
  return ()=>{resize.disconnect();children.disconnect();box.removeEventListener('scroll',schedule);if(frame!==null)cancelAnimationFrame(frame);};
 },[container]);
 return <button type="button" className="conversation-latest" hidden={!visible} aria-label="回到最新消息" title="回到最新消息" aria-controls="session-view-panel" onClick={()=>{onJump();container.current?.focus({preventScroll:true});}}><Glyph name="down" size={19}/></button>;
}
