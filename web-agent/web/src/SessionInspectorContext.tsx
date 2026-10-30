import {createContext,useCallback,useContext,useMemo,useEffect,useRef,useState,type ReactNode} from 'react';
import {atConversationTail} from './followScroll';
import type {SRETask} from '../../shared/contracts';

export type InspectorSelection={sessionId:string;taskId?:string;task?:SRETask;attemptId?:string;evidenceId?:string;turnId?:string;followLatest?:boolean;automatic?:boolean;tab:'plan'|'execution'};
type InspectorState={selection:InspectorSelection|null;lastSelection:InspectorSelection|null;host:HTMLDivElement|null;open:(target:InspectorSelection)=>void;close:()=>void;reset:()=>void;setHost:(node:HTMLDivElement|null)=>void};
const InspectorContext=createContext<InspectorState|null>(null);
export const useSessionInspector=()=>useContext(InspectorContext);
export const sessionInspectorId='session-task-inspector';

// Opening a side pane changes line wrapping. Keep the visible message anchored
// rather than scrolling the conversation to the inspected plan or operation.
function retainConversation(){
 const box=document.querySelector<HTMLElement>('.conversation');
 if(!box)return()=>{};
 // A reader already at the latest reply keeps the tail through reflow. Only
 // history reading needs a message anchor; opening a pane never pauses following.
 if(atConversationTail(box))return()=>{box.scrollTop=Math.max(0,box.scrollHeight-box.clientHeight);};
 const top=box.getBoundingClientRect().top;
 const anchor=[...box.querySelectorAll<HTMLElement>('.sre-role-message,.ai-response,.ai-chat-message')].find(node=>node.getBoundingClientRect().bottom>top+80);
 const offset=anchor?.getBoundingClientRect().top;
 return()=>{if(anchor?.isConnected&&offset!==undefined)box.scrollTop+=anchor.getBoundingClientRect().top-offset;};
}

export function SessionInspectorProvider({children}:{children:ReactNode}){
 const [selection,setSelection]=useState<InspectorSelection|null>(null),[lastSelection,setLastSelection]=useState<InspectorSelection|null>(null),[host,setHost]=useState<HTMLDivElement|null>(null);
 const opener=useRef<HTMLElement|null>(null),frame=useRef<number|undefined>(undefined);
 useEffect(()=>()=>{if(frame.current)cancelAnimationFrame(frame.current);},[]);
 const open=useCallback((target:InspectorSelection)=>{
  const restore=retainConversation();
  if(document.activeElement instanceof HTMLElement&&!document.activeElement.closest(`#${sessionInspectorId}`))opener.current=document.activeElement;
  setSelection(target);setLastSelection(target);
  if(frame.current)cancelAnimationFrame(frame.current);
  frame.current=requestAnimationFrame(restore);
 },[]);
 const close=useCallback(()=>{
  const restore=retainConversation();setSelection(null);
  if(frame.current)cancelAnimationFrame(frame.current);
  frame.current=requestAnimationFrame(()=>{
   restore();
   const usable=(node:HTMLElement|null):node is HTMLElement=>!!node&&node.isConnected&&node!==document.body&&!node.closest('[inert],[aria-hidden="true"]')&&node.getBoundingClientRect().width>0;
   const target=usable(opener.current)?opener.current:[...document.querySelectorAll<HTMLElement>('.workspace-header .header-inspector-toggle,.workspace-header .pilot-island-trigger')].find(usable);
   target?.focus({preventScroll:true});
  });
 },[]);
 const reset=useCallback(()=>{if(frame.current)cancelAnimationFrame(frame.current);setSelection(null);setLastSelection(null);opener.current=null;},[]);
 const value=useMemo(()=>({selection,lastSelection,host,setHost,open,close,reset}),[selection,lastSelection,host,open,close,reset]);
 return <InspectorContext.Provider value={value}>{children}</InspectorContext.Provider>;
}
