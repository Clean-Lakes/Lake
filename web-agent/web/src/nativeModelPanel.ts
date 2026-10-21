import {useEffect,useId,useLayoutEffect,useRef,useState,type RefObject} from "react";
import type {ComposerModelSelectProps} from "./ComposerModelSelect";
import type {ReasoningSelectorProps} from "./ReasoningSelector";

type Bridge={role:"workbench"|"panel";command:(message:Record<string,unknown>)=>Promise<unknown>};
declare global {interface Window {lakeNativeModelPanel?:Bridge;}}
export type NativeModelPanelState=Pick<ComposerModelSelectProps,"available"|"modelName"|"selection"|"disabled">&{
  id:string;presentation:number;theme:"light"|"dark";reasoning?:Omit<ReasoningSelectorProps,"onSaving">;
  anchor:{left:number;top:number;width:number;height:number};
};
export type NativeModelPanelEvent={id:string;kind:"close"|"select"|"saving"|"settings";value?:string;saving?:boolean;session?:string;restoreFocus?:boolean};
export function nativePanelCommand(message:Record<string,unknown>) {return window.lakeNativeModelPanel!.command(message);}

/** Only the macOS host advertises this capability. Browser/older macOS use AppSelect's web surface. */
export function useNativeModelPanel(props:ComposerModelSelectProps,anchor:RefObject<HTMLSpanElement|null>) {
  const id=useId(),latest=useRef(props);latest.current=props;
  const [failed,setFailed]=useState(false),[theme,setTheme]=useState(document.documentElement.dataset.theme);
  const native=window.lakeNativeModelPanel?.role==="workbench"&&!failed;
  const savingCallback=useRef(props.reasoning?.onSaving);
  if(props.reasoning) savingCallback.current=props.reasoning.onSaving;
  const savingSessions=useRef(new Set<string>());
  const sent=useRef("");
  const presentation=useRef(0);
  useEffect(()=>{
    if(!native) return;
    const observer=new MutationObserver(()=>setTheme(document.documentElement.dataset.theme));
    observer.observe(document.documentElement,{attributes:true,attributeFilter:["data-theme"]});
    const receive=(event:Event)=>{
      const detail=(event as CustomEvent<NativeModelPanelEvent>).detail;
      if(!detail||detail.id!==id) return;
      const current=latest.current;
      if(detail.kind==="saving"&&typeof detail.saving==="boolean"&&detail.session) {
        if(detail.saving) savingSessions.current.add(detail.session);else savingSessions.current.delete(detail.session);
        savingCallback.current?.(detail.saving,detail.session);
      }
      if(detail.kind==="settings") current.onSettings();
      if(detail.kind==="close") {current.onOpenChange(false);if(detail.restoreFocus) anchor.current?.querySelector("button")?.focus({preventScroll:true});}
      if(detail.kind==="select"&&!current.disabled) {
        const row=current.available.entries?.find(entry=>JSON.stringify([entry.providerId,entry.modelId])===detail.value);
        if(row) current.onSelect(row);
        else if(!current.available.entries&&current.available.models.includes(detail.value||"")) current.onSelect(detail.value!);
        current.onOpenChange(false);
      }
    };
    window.addEventListener("lake-native-model-event",receive);
    return()=>{for(const session of savingSessions.current) savingCallback.current?.(false,session);savingSessions.current.clear();observer.disconnect();window.removeEventListener("lake-native-model-event",receive);void nativePanelCommand({action:"close",id}).catch(()=>{});};
  },[native,id]);
  useLayoutEffect(()=>{
    if(!native) return;
    if(!props.open||!props.configured) {
      if(sent.current) {sent.current="";void nativePanelCommand({action:"close",id}).catch(()=>{});}
      return;
    }
    const rect=anchor.current?.querySelector("button")?.getBoundingClientRect();
    if(!rect) return;
    const {onSaving:_,...reasoning}=props.reasoning||{} as ReasoningSelectorProps;
    if(!sent.current) presentation.current++;
    const state:NativeModelPanelState={id,presentation:presentation.current,available:props.available,modelName:props.modelName,selection:props.selection,disabled:props.disabled,theme:theme==="dark"?"dark":"light",reasoning:props.reasoning?reasoning:undefined,anchor:{left:rect.left,top:rect.top,width:rect.width,height:rect.height}};
    const json=JSON.stringify(state);
    if(sent.current===json) return;
    sent.current=json;
    void nativePanelCommand({action:"show",state}).catch(()=>setFailed(true));
  });
  return native;
}
