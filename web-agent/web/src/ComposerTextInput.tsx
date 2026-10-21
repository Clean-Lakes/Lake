import {forwardRef,useEffect,useId,useImperativeHandle,useLayoutEffect,useRef,useState,type ClipboardEvent,type HTMLAttributes,type ReactNode} from 'react';
import {api} from './api';
import {Glyph} from './Icons';
import {CompositionGuard} from './composerKeyboard';
import {completionDelay,completionEligible,localCompletion,validCompletion} from './composerCompletion';
import {composerClipboardFragment,composerMessage,composerToken,replaceComposerRange,type ComposerReference} from './composerMentionState';
import {composerCaretCharacter,composerRangeOffsets,composerSelection,readComposerDocument,referenceKey,setComposerSelection} from './composerDocument';

export type ComposerInputHandle={focus:(options?:FocusOptions)=>void;setSelectionRange:(start:number,end:number)=>void;readonly selectionStart:number;readonly selectionEnd:number;readonly value:string};
type Props=Omit<HTMLAttributes<HTMLDivElement>,'onChange'|'onSelect'> & {value:string;references:ComposerReference[];renderReference:(ref:ComposerReference)=>ReactNode;sessionId:string;modelId?:string;modelSource?:string;history:string[];completionBlocked?:boolean;disabled?:boolean;placeholder?:string;onChange:(value:string,references:ComposerReference[],caret:number)=>void;onComplete:(value:string)=>void};
type Edit={value:string;references:ComposerReference[];start:number;end:number};
const signature=(value:string,refs:ComposerReference[])=>JSON.stringify([value,refs.map(ref=>[referenceKey(ref),ref.label,ref.position])]);
export const ComposerTextInput=forwardRef<ComposerInputHandle,Props>(function ComposerTextInput({value,references,renderReference,sessionId,modelId,modelSource,history,completionBlocked=false,disabled=false,placeholder,onComplete,onChange,onKeyDown,onPaste,onFocus,onBlur,onCompositionStart,onCompositionEnd,...props},forwardedRef) {
 const input=useRef<HTMLDivElement>(null),templates=useRef<HTMLDivElement>(null),guard=useRef(new CompositionGuard());
 const [focused,setFocused]=useState(false),[composing,setComposing]=useState(false),[selection,setSelection]=useState({start:0,end:0});
 const caret=useRef({start:0,end:0}),restore=useRef<{start:number;end:number}|null>(null);
 const edits=useRef<Edit[]>([{value,references,start:0,end:0}]),editIndex=useRef(0);
 const latest=useRef({value,references,sessionId,modelId,modelSource});latest.current={value,references,sessionId,modelId,modelSource};
 const known=useRef(new Map<string,ComposerReference>());for(const ref of references)known.current.set(referenceKey(ref),ref);
 const historyRef=useRef(history);historyRef.current=history;
 const [dismissed,setDismissed]=useState<string|null>(null),[suggestion,setSuggestion]=useState<{prefix:string;suffix:string}|null>(null);
 const statusId=`composer-completion-${useId()}`;
 const eligible=completionEligible(value,selection.start,selection.end,focused,composing,completionBlocked||disabled);
 const suffix=eligible&&dismissed!==value&&suggestion?.prefix===value?suggestion.suffix:'';
 function syncSelection(){const range=input.current&&composerSelection(input.current,latest.current.references);if(range){caret.current=range;setSelection(current=>current.start===range.start&&current.end===range.end?current:range);}return range??caret.current;}
 function remember(value:string,refs:ComposerReference[],range:{start:number;end:number}) {
  const current=edits.current[editIndex.current]!;
  if(signature(current.value,current.references)===signature(value,refs)){Object.assign(current,range);return;}
  edits.current=edits.current.slice(0,editIndex.current+1);edits.current.push({value,references:refs,...range});
  if(edits.current.length>100)edits.current.shift();editIndex.current=edits.current.length-1;
 }
 function publish(next:string,refs:ComposerReference[],range:{start:number;end:number},move=false,record=true){if(record)remember(next,refs,range);caret.current=range;setSelection(range);if(move)restore.current=range;onChange(next,refs,range.end);}
 function apply(start:number,end:number,text:string,inserted:ComposerReference[]=[]){const current=latest.current;const next=replaceComposerRange(current.value,current.references,start,end,text,inserted);publish(next.next,next.references,{start:next.position,end:next.position},true);}
 function undo(redo=false){const next=editIndex.current+(redo?1:-1);if(next<0||next>=edits.current.length)return;editIndex.current=next;const entry=edits.current[next]!;restore.current={start:entry.start,end:entry.end};caret.current=restore.current;setSelection(restore.current);onChange(entry.value,entry.references,entry.end);}
 useImperativeHandle(forwardedRef,()=>({focus:options=>input.current?.focus(options),setSelectionRange:(start,end)=>{caret.current={start,end};setSelection({start,end});if(input.current)setComposerSelection(input.current,start,end);Object.assign(edits.current[editIndex.current]!,{start,end});},get selectionStart(){return caret.current.start},get selectionEnd(){return caret.current.end},get value(){return latest.current.value}}),[]);
 useEffect(()=>{const changed=()=>{if(input.current?.ownerDocument.activeElement===input.current)syncSelection();};document.addEventListener('selectionchange',changed);return()=>document.removeEventListener('selectionchange',changed);},[]);
 useLayoutEffect(()=>{
  const root=input.current;if(!root||composing)return;
  const active=root.ownerDocument.activeElement===root;
  const current=readComposerDocument(root,references),wanted=signature(value,references);
  remember(value,references,caret.current);
  const boundary=root.querySelector('[data-composer-caret]'),needsBoundary=value.endsWith(composerToken);
  if(signature(current.value,current.references)!==wanted||root.querySelector('br:not([data-composer-break]):not([data-composer-placeholder]),div,p')||needsBoundary!==!!boundary||boundary&&boundary.textContent!==composerCaretCharacter){
   const fragment=root.ownerDocument.createDocumentFragment();const refs=new Map(references.map(ref=>[ref.position,ref]));let text='';
   const flush=()=>{if(text)fragment.appendChild(root.ownerDocument.createTextNode(text));text='';};
   for(let i=0;i<value.length;i++){
    if(value[i]==='\n'){flush();const br=root.ownerDocument.createElement('br');br.dataset.composerBreak='';fragment.appendChild(br);continue;}
    if(value[i]!==composerToken){text+=value[i];continue;}flush();
    const ref=refs.get(i),template=ref&&[...(templates.current?.children??[])].find(el=>el.getAttribute('data-composer-token')===referenceKey(ref));
    if(template)fragment.appendChild(template.cloneNode(true));
   }
   flush();
   if(needsBoundary){const tail=root.ownerDocument.createElement('span');tail.dataset.composerCaret='';tail.textContent=composerCaretCharacter;fragment.appendChild(tail);}
   if(value.endsWith('\n')){const placeholder=root.ownerDocument.createElement('br');placeholder.dataset.composerPlaceholder='';fragment.appendChild(placeholder);}root.replaceChildren(fragment);
   if(active)setComposerSelection(root,Math.min(value.length,caret.current.start),Math.min(value.length,caret.current.end));
  }
  root.querySelectorAll<HTMLButtonElement>('[data-remove-composer-token]').forEach(button=>{button.disabled=disabled;});
  root.querySelectorAll('[data-composer-suggestion]').forEach(el=>el.remove());
  if(suffix){const ghost=root.ownerDocument.createElement('span');ghost.dataset.composerSuggestion='';ghost.className='composer-inline-suggestion';ghost.contentEditable='false';ghost.setAttribute('aria-hidden','true');ghost.textContent=suffix;root.appendChild(ghost);}
  if(restore.current){const range=restore.current;restore.current=null;root.focus({preventScroll:true});setComposerSelection(root,range.start,range.end);}
 },[value,references,suffix,composing,disabled]);
 useEffect(()=>{
  setSuggestion(null);if(!eligible||dismissed===value)return;
  const controller=new AbortController();const text=composerMessage(value,references,references.filter(ref=>ref.kind==='resource').map(ref=>ref.resourceId)).text;
  const timer=setTimeout(()=>{
   const fallback=localCompletion(text,historyRef.current);if(fallback)setSuggestion({prefix:value,suffix:fallback});
   void api.completeDraft(sessionId,text,modelId,controller.signal).then(result=>{const current=latest.current;if(controller.signal.aborted||current.value!==value||current.sessionId!==sessionId||current.modelId!==modelId||current.modelSource!==modelSource||result.modelId&&modelId&&result.modelId!==modelId)return;if(validCompletion(result.suffix))setSuggestion({prefix:value,suffix:result.suffix});}).catch(()=>{});
  },completionDelay);return()=>{clearTimeout(timer);controller.abort();};
 },[value,references,sessionId,modelId,modelSource,eligible,dismissed]);
 function accept(){if(!suffix)return;const next=value+suffix;restore.current={start:next.length,end:next.length};setDismissed(next);setSuggestion(null);onComplete(next);}
 function copy(event:ClipboardEvent<HTMLDivElement>,cut=false){const range=syncSelection();if(range.start===range.end){event.preventDefault();return;}const part=replaceComposerRange(value,references,range.end,value.length,'');const clipped=replaceComposerRange(part.next,part.references,0,range.start,'');const refs=new Map(clipped.references.map(ref=>[ref.position,ref]));const text=[...clipped.next.split('')].map((char,index)=>char===composerToken?refs.get(index)?.label.slice(1)??'':char).join('');event.clipboardData.setData('text/plain',text);event.clipboardData.setData('application/x-lake-composer',JSON.stringify({version:1,value:clipped.next,references:clipped.references.map(ref=>({kind:ref.kind,resourceId:ref.resourceId,position:ref.position}))}));event.preventDefault();if(cut&&!disabled)apply(range.start,range.end,'');}
 return <div className={`composer-text ${suffix?'has-completion':''}`}>
  <div ref={templates} hidden aria-hidden="true">{references.map(ref=><span key={`${referenceKey(ref)}:${ref.position}`} className="composer-reference-token" contentEditable={false} data-composer-token={referenceKey(ref)} title={ref.label.slice(1)}>{renderReference(ref)}<button type="button" tabIndex={-1} data-remove-composer-token="" aria-label={`移除引用 ${ref.label.slice(1)}`} disabled={disabled}><Glyph name="close" size={11}/></button></span>)}</div>
  <div {...props} ref={input} className="composer-rich-input" contentEditable={!disabled} suppressContentEditableWarning role={props.role??'textbox'} aria-label={props['aria-label']??'给 Lake 的消息'} aria-multiline="true" aria-disabled={disabled} aria-autocomplete={props['aria-autocomplete']??'inline'} aria-describedby={[props['aria-describedby'],suffix?statusId:''].filter(Boolean).join(' ')||undefined} data-placeholder={placeholder} data-empty={!value}
   onInput={()=>{if(!input.current)return;const next=readComposerDocument(input.current,latest.current.references);const range=composerSelection(input.current,next.references)??caret.current;publish(next.value,next.references,range,false,!composing);}}
   onBeforeInput={event=>{const range=syncSelection();if((event.nativeEvent as InputEvent).isComposing)return;Object.assign(edits.current[editIndex.current]!,range);const type=(event.nativeEvent as InputEvent).inputType;if(type==='historyUndo'||type==='historyRedo'){event.preventDefault();undo(type==='historyRedo');}else if(type==='insertParagraph'||type==='insertLineBreak'){event.preventDefault();apply(range.start,range.end,'\n');}else if(type?.startsWith('delete')){const target=(event.nativeEvent as InputEvent).getTargetRanges?.()[0];const deleting=target&&input.current?composerRangeOffsets(input.current,references,target):null;if(deleting){event.preventDefault();apply(deleting.start,deleting.end,'');}}}}
   onFocus={event=>{setFocused(true);syncSelection();onFocus?.(event);}} onBlur={event=>{setFocused(false);setComposing(false);guard.current=new CompositionGuard();onBlur?.(event);}}
   onMouseUp={()=>syncSelection()} onKeyUp={()=>syncSelection()}
   onCompositionStart={event=>{guard.current.start();setComposing(true);onCompositionStart?.(event);}} onCompositionEnd={event=>{guard.current.end();setComposing(false);if(input.current){const next=readComposerDocument(input.current,latest.current.references);publish(next.value,next.references,composerSelection(input.current,next.references)??caret.current);}onCompositionEnd?.(event);}}
   onMouseDown={event=>{if((event.target as Element).closest('[data-remove-composer-token]'))event.preventDefault();}}
   onClick={event=>{const button=(event.target as Element).closest('[data-remove-composer-token]');if(!button||disabled)return;const token=button.closest('[data-composer-token]');const nodes=[...input.current!.querySelectorAll('[data-composer-token]')];const index=nodes.indexOf(token!);const ref=readComposerDocument(input.current!,references).references[index];if(ref)apply(ref.position,ref.position+1,'');}}
   onCopy={event=>copy(event)} onCut={event=>copy(event,true)}
   onPaste={event=>{onPaste?.(event);if(event.defaultPrevented||disabled)return;event.preventDefault();const range=syncSelection();const fragment=composerClipboardFragment(event.clipboardData.getData('application/x-lake-composer'),[...known.current.values()]);if(fragment)apply(range.start,range.end,fragment.value,fragment.references);else apply(range.start,range.end,event.clipboardData.getData('text/plain').replace(/\r\n?/g,'\n').replaceAll(composerToken,''));}}
   onDragOver={event=>{if(!Array.from(event.dataTransfer.types).includes('Files'))event.preventDefault();}}
   onDrop={event=>{if(Array.from(event.dataTransfer.types).includes('Files'))return;event.preventDefault();event.stopPropagation();if(disabled)return;const target=input.current?.ownerDocument.caretRangeFromPoint?.(event.clientX,event.clientY);const range=target&&input.current?composerRangeOffsets(input.current,references,target):null;const where=range??syncSelection();apply(where.start,where.end,event.dataTransfer.getData('text/plain').replace(/\r\n?/g,'\n').replaceAll(composerToken,''));}}
   onKeyDown={event=>{
    syncSelection();onKeyDown?.(event);if(event.defaultPrevented||guard.current.ignores(event.nativeEvent)||disabled)return;Object.assign(edits.current[editIndex.current]!,caret.current);
    const range=caret.current;
    if((event.metaKey||event.ctrlKey)&&!event.altKey&&event.key.toLowerCase()==='z'){event.preventDefault();undo(event.shiftKey);return;}
    if(event.ctrlKey&&!event.metaKey&&!event.altKey&&event.key.toLowerCase()==='y'){event.preventDefault();undo(true);return;}
    if(event.key==='Backspace'&&range.start===range.end&&value[range.start-1]===composerToken){event.preventDefault();apply(range.start-1,range.end,'');return;}
    if(event.key==='Delete'&&range.start===range.end&&value[range.start]===composerToken){event.preventDefault();apply(range.start,range.end+1,'');return;}
    if((event.key==='Backspace'||event.key==='Delete')&&range.start!==range.end&&value.slice(range.start,range.end).includes(composerToken)){event.preventDefault();apply(range.start,range.end,'');return;}
    if(event.key==='Enter'){event.preventDefault();apply(range.start,range.end,'\n');return;}
    if(event.key==='Escape'&&eligible){event.preventDefault();event.stopPropagation();setDismissed(value);setSuggestion(null);return;}
    if(event.key==='Tab'&&suffix&&!event.shiftKey&&!event.ctrlKey&&!event.metaKey&&!event.altKey&&!event.repeat&&!completionBlocked){event.preventDefault();accept();}
   }}/>
  {suffix&&<div className="composer-completion-hint"><button type="button" aria-label="接受补齐建议" onMouseDown={event=>event.preventDefault()} onClick={accept}><kbd>Tab</kbd>补齐</button><button type="button" aria-label="忽略补齐建议" onMouseDown={event=>event.preventDefault()} onClick={()=>{setDismissed(value);setSuggestion(null);}}><kbd>Esc</kbd>忽略</button></div>}
  <span id={statusId} className="visually-hidden" role="status">{suffix?`补齐建议：${suffix} 按 Tab 接受，Escape 忽略。`:''}</span>
 </div>;
});
