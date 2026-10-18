import {forwardRef,useEffect,useId,useLayoutEffect,useRef,useState,type TextareaHTMLAttributes} from "react";
import {api} from "./api";
import {CompositionGuard} from "./composerKeyboard";
import {completionDelay,completionEligible,localCompletion,validCompletion} from "./composerCompletion";

type Props=Omit<TextareaHTMLAttributes<HTMLTextAreaElement>,"value">&{value:string;sessionId:string;modelId?:string;modelSource?:string;history:string[];completionBlocked?:boolean;onComplete:(value:string)=>void};
export const ComposerTextInput=forwardRef<HTMLTextAreaElement,Props>(function ComposerTextInput({value,sessionId,modelId,modelSource,history,completionBlocked=false,onComplete,onChange,onKeyDown,onFocus,onBlur,onSelect,onScroll,onCompositionStart,onCompositionEnd,disabled,...props},forwardedRef) {
 const input=useRef<HTMLTextAreaElement|null>(null),mirror=useRef<HTMLDivElement>(null),measure=useRef<HTMLDivElement>(null),guard=useRef(new CompositionGuard());
 const [focused,setFocused]=useState(false),[composing,setComposing]=useState(false),[selection,setSelection]=useState({start:0,end:0});
 const [dismissed,setDismissed]=useState<string|null>(null),[suggestion,setSuggestion]=useState<{prefix:string;suffix:string}|null>(null);
 const latest=useRef({value,sessionId,modelId,modelSource});latest.current={value,sessionId,modelId,modelSource};
 const historyRef=useRef(history);historyRef.current=history;
 const statusId=`composer-completion-${useId()}`;
 const eligible=completionEligible(value,selection.start,selection.end,focused,composing,completionBlocked||!!disabled);
 const suffix=eligible&&dismissed!==value&&suggestion?.prefix===value?suggestion.suffix:"";
 const syncSelection=(target:HTMLTextAreaElement)=>setSelection({start:target.selectionStart,end:target.selectionEnd});
 useEffect(()=>{
  setSuggestion(null);
  if(!eligible||dismissed===value) return;
  const controller=new AbortController();
  const timer=setTimeout(()=>{
   const fallback=localCompletion(value,historyRef.current);
   if(fallback) setSuggestion({prefix:value,suffix:fallback});
   void api.completeDraft(sessionId,value,modelId,controller.signal).then(result=>{
    const current=latest.current;
    if(controller.signal.aborted||current.value!==value||current.sessionId!==sessionId||current.modelId!==modelId||current.modelSource!==modelSource||input.current?.value!==value||result.modelId&&modelId&&result.modelId!==modelId) return;
    if(validCompletion(result.suffix)) setSuggestion({prefix:value,suffix:result.suffix});
   }).catch(()=>{/* Completion failures leave normal editing and the local suggestion available. */});
  },completionDelay);
  return()=>{clearTimeout(timer);controller.abort();};
 },[value,sessionId,modelId,modelSource,eligible,dismissed]);
 useLayoutEffect(()=>{
  const target=input.current,ghost=mirror.current,typed=measure.current;
  if(!target||!ghost||!typed) return;
  const resize=()=>{
   const scroll=target.scrollTop;
   for(let pass=0;pass<2;pass++) {
    // Measure separate mirrors without collapsing the focused textarea.
    // WebKit can lose its caret/scroll position during a zero-height resize.
    ghost.style.width=typed.style.width=`${target.clientWidth}px`;
    const textHeight=typed.scrollHeight;
    const height=Math.max(textHeight,ghost.scrollHeight);
    // Reserve the continuation's extra lines in the textarea's scrollable area.
    target.style.paddingBottom=`${3+Math.max(0,ghost.scrollHeight-textHeight)}px`;
    target.style.height=`${Math.min(160,Math.max(30,height))}px`;
    target.style.overflowY=height>160?"auto":"hidden";
   }
   const atEnd=document.activeElement===target&&target.selectionStart===value.length&&target.selectionEnd===value.length;
   target.scrollTop=atEnd?target.scrollHeight:scroll;
   ghost.style.transform=`translateY(-${target.scrollTop}px)`;
  };
  resize();let width=target.clientWidth;
  const observer=new ResizeObserver(()=>{if(target.clientWidth!==width){width=target.clientWidth;resize();}});
  observer.observe(target);return()=>observer.disconnect();
 },[value,suffix]);
 function accept() {
  if(!suffix||!input.current) return;
  const next=value+suffix;
  setDismissed(next);setSuggestion(null);onComplete(next);
  requestAnimationFrame(()=>{input.current?.focus();input.current?.setSelectionRange(next.length,next.length);setSelection({start:next.length,end:next.length});});
 }
 return <div className={`composer-text ${suffix?"has-completion":""}`}>
  <div className="composer-text-field"><div className="composer-ghost-viewport" aria-hidden="true"><div ref={mirror} className="composer-ghost"><span className="composer-ghost-prefix">{value}</span><span>{suffix}</span>{"\u200b"}</div><div ref={measure} className="composer-ghost composer-input-measure">{value}{"\u200b"}</div></div>
   <textarea {...props} ref={node=>{input.current=node;if(typeof forwardedRef==="function") forwardedRef(node);else if(forwardedRef) forwardedRef.current=node;}} value={value} disabled={disabled} aria-autocomplete={props["aria-autocomplete"]??"inline"} aria-describedby={[props["aria-describedby"],suffix?statusId:""].filter(Boolean).join(" ")||undefined}
    onChange={event=>{syncSelection(event.currentTarget);onChange?.(event);}}
    onFocus={event=>{setFocused(true);syncSelection(event.currentTarget);onFocus?.(event);}}
    onBlur={event=>{setFocused(false);setComposing(false);guard.current=new CompositionGuard();onBlur?.(event);}}
    onSelect={event=>{syncSelection(event.currentTarget);onSelect?.(event);}}
    onScroll={event=>{if(mirror.current) mirror.current.style.transform=`translateY(-${event.currentTarget.scrollTop}px)`;onScroll?.(event);}}
    onCompositionStart={event=>{guard.current.start();setComposing(true);onCompositionStart?.(event);}}
    onCompositionEnd={event=>{guard.current.end();setComposing(false);syncSelection(event.currentTarget);onCompositionEnd?.(event);}}
    onKeyDown={event=>{
     onKeyDown?.(event);
     if(event.defaultPrevented||guard.current.ignores(event.nativeEvent)||completionBlocked) return;
     if(event.key==="Escape"&&eligible){event.preventDefault();event.stopPropagation();setDismissed(value);setSuggestion(null);return;}
     if(event.key==="Tab"&&suffix&&!event.shiftKey&&!event.ctrlKey&&!event.metaKey&&!event.altKey&&!event.repeat){event.preventDefault();accept();}
    }}/>
  </div>
  {suffix&&<div className="composer-completion-hint"><button type="button" aria-label="接受补齐建议" onMouseDown={event=>event.preventDefault()} onClick={accept}><kbd>Tab</kbd>补齐</button><button type="button" aria-label="忽略补齐建议" onMouseDown={event=>event.preventDefault()} onClick={()=>{setDismissed(value);setSuggestion(null);}}><kbd>Esc</kbd>忽略</button></div>}
  <span id={statusId} className="visually-hidden" role="status">{suffix?`补齐建议：${suffix} 按 Tab 接受，Escape 忽略。`:""}</span>
 </div>;
});
