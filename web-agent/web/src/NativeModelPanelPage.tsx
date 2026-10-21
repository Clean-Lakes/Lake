import {useEffect,useLayoutEffect,useState} from "react";
import {ComposerModelSelect} from "./ComposerModelSelect";
import {nativePanelCommand,type NativeModelPanelState,type NativeModelPanelEvent} from "./nativeModelPanel";
import "./nativeModelPanel.css";

/** A transparent content view; NSGlassEffectView supplies the material, rim and shadow. */
export function NativeModelPanelPage() {
  const [state,setState]=useState<NativeModelPanelState|null>(null);
  const [saving,setSaving]=useState(false);
  useLayoutEffect(()=>{
    document.documentElement.classList.add("lake-native-model-panel");
    const receive=(event:Event)=>setState((event as CustomEvent<NativeModelPanelState>).detail);
    window.addEventListener("lake-native-model-state",receive);
    void nativePanelCommand({action:"ready"});
    return()=>window.removeEventListener("lake-native-model-state",receive);
  },[]);
  useLayoutEffect(()=>{if(state) document.documentElement.dataset.theme=state.theme;},[state?.theme]);
  useEffect(()=>{
    let observed:Element|null=null;
    const resize=new ResizeObserver(entries=>{
      const popup=entries[0]?.target;
      if(popup) void nativePanelCommand({action:"resize",height:Math.ceil(popup.getBoundingClientRect().height)});
    });
    const attach=()=>{
      const popup=document.querySelector(".composer-model-popup");
      if(!popup||popup===observed) return;
      resize.disconnect();observed=popup;resize.observe(popup);
      // AppSelect retains keyboard navigation without a second visible trigger.
      if(document.activeElement===document.body) (document.querySelector('[role="combobox"]') as HTMLElement|null)?.focus({preventScroll:true});
    };
    const mutations=new MutationObserver(attach);
    mutations.observe(document.body,{childList:true,subtree:true});attach();
    const tab=(event:KeyboardEvent)=>{
      if(event.key!=="Tab") return;
      const controls=[...document.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled)')].filter(element=>element.getClientRects().length>0);
      const index=controls.indexOf(document.activeElement as HTMLElement);
      if(event.shiftKey&&index<=0||!event.shiftKey&&index===controls.length-1) {event.preventDefault();void nativePanelCommand({action:"close"});}
    };
    document.addEventListener("keydown",tab);
    return()=>{resize.disconnect();mutations.disconnect();document.removeEventListener("keydown",tab);};
  },[]);
  if(!state) return null;
  const relay=(event:Omit<NativeModelPanelEvent,"id">)=>{void nativePanelCommand({action:"event",event:{id:state.id,...event}});};
  return <ComposerModelSelect {...state} disabled={state.disabled||saving} configured open onOpenChange={()=>{}} onSettings={()=>relay({kind:"settings"})} onProviderMenu={async request=>await nativePanelCommand({action:"providers",...request}) as string|null}
    onSelect={model=>relay({kind:"select",value:typeof model==="string"?model:JSON.stringify([model.providerId,model.modelId])})}
    reasoning={state.reasoning?{...state.reasoning,onSaving:saving=>{setSaving(saving);relay({kind:"saving",saving,session:state.reasoning!.session});}}:undefined}/>;
}
