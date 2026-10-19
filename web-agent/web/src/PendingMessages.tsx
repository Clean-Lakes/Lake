import {MessageText} from './MessageText';
import {rebaseMessageMentions} from './messageMentions';
import {Glyph} from './Icons';
import {rebaseExtensionReferences} from "../../shared/references";
import {useLayoutEffect,useRef,useState} from "react";
import type {MessageQueue,QueueOperation,QueuedMessage,MessageMention} from "../../shared/contracts";
import {api,readableError} from "./api";
import {CompositionGuard,isSendKey,type SendShortcut} from "./composerKeyboard";
import {reorderQueuedMessages} from "./messageQueue";
import {useQueueDrag} from "./useQueueDrag";
import "./pendingMessages.css";

export function PendingMessages({sessionId,queue,disabled,active,sendShortcut,resourceIds,onUpdated}: {
 sessionId:string;queue:MessageQueue;disabled:boolean;active:boolean;sendShortcut:SendShortcut;resourceIds:(text:string)=>string[];onUpdated:(queue:MessageQueue)=>void;
}) {
 const [busy,setBusy]=useState(false);
 const [error,setError]=useState("");
 const [editor,setEditor]=useState<{id:string;text:string;original:string;references:Record<string,unknown>[];mentions:MessageMention[]} | null>(null);

 const panel=useRef<HTMLElement>(null);
 const composition=useRef(new CompositionGuard());
 function finishEditing(id:string) {
  setEditor(null);
  requestAnimationFrame(()=>{
   const target=[...(panel.current?.querySelectorAll<HTMLButtonElement>('[data-queue-edit]')??[])].find(button=>button.dataset.queueEdit===id);
   (target??panel.current?.querySelector<HTMLButtonElement>('button:not(:disabled)'))?.focus({preventScroll:true});
  });
 }
 async function mutate(data:QueueOperation):Promise<MessageQueue|null> {
  if (disabled || busy) return null;
  setBusy(true);setError("");
  try {const next=await api.updateMessageQueue(sessionId,data);onUpdated(next);return next;}
  catch(e) {setError(readableError(e));try {onUpdated(await api.messageQueue(sessionId));} catch {}return null;}
  finally {setBusy(false);}
 }
 async function edit(item:QueuedMessage) {
  const next=await mutate({operation:"pause",revision:queue.revision});
  if (!next) return;
  const pending=next.items.find(row => row.id===item.id);
  if (!pending) {setError("这条消息已发送或移除");return;}
  setEditor({id:pending.id,text:pending.text,original:pending.text,references:pending.references??[],mentions:pending.mentions??[]});composition.current=new CompositionGuard();
 }
 async function saveEdit() {
  if (!editor?.text.trim()) return;
  const next=await mutate({operation:"edit",revision:queue.revision,id:editor.id,text:editor.text.trim(),resourceIds:queue.items.find(item=>item.id===editor.id)?.resourceIds??resourceIds(editor.text),references:rebaseExtensionReferences(editor.original,editor.text.trim(),editor.references),mentions:rebaseMessageMentions(editor.original,editor.text.trim(),editor.mentions)});
  if (next) finishEditing(editor.id);
 }
 async function move(id:string,position:number) {
  const ids=queue.items.map(item => item.id);
  const next=reorderQueuedMessages(ids,id,position);
  if (next!==ids && next.some((value,index) => value!==ids[index])) {
   const updated=await mutate({operation:"reorder",revision:queue.revision,ids:next});
   if(updated)requestAnimationFrame(()=>{
    const handle=[...(panel.current?.querySelectorAll<HTMLButtonElement>('[data-queue-grip]')??[])].find(button=>button.dataset.queueGrip===id);
    handle?.focus({preventScroll:true});
    handle?.scrollIntoView({block:"nearest",inline:"nearest"});
   });
  }
 }
 const sorting=useQueueDrag({ids:queue.items.map(item=>item.id),revision:queue.revision,disabled:disabled || busy || !!editor,onMove:(id,position)=>void move(id,position),onStale:()=>setError("队列已更新，请重新拖动排序")});
 const hasContent=!!(queue.items.length || editor || error);
 // The queue floats over the scroll canvas; reserve its measured height only at
 // the end of the transcript, so older text can still pass behind the glass.
 useLayoutEffect(()=>{
  const element=panel.current;
  const view=element?.closest<HTMLElement>(".session-view");
  if (!element || !view) return;
  const measure=()=>view.style.setProperty("--pending-messages-height",`${element.getBoundingClientRect().height+8}px`);
  measure();
  const observer=new ResizeObserver(measure);
  observer.observe(element);
  return ()=>{observer.disconnect();view.style.removeProperty("--pending-messages-height");};
 },[hasContent]);
 if (!hasContent) return null;
 const blocked=disabled || busy;
 return <section ref={panel} className="pending-messages" aria-label="待发送消息">
  <span className="visually-hidden" role="status">{queue.items.length} 条 · {queue.paused ? "已暂停" : active ? "本轮结束后发送" : "按顺序发送"}</span>
  {queue.lastError && <p className="pending-messages-note" role="status">{queue.lastError}</p>}{error && <p className="pending-messages-error" role="alert">{error}</p>}
  <ol ref={sorting.list} className={`pending-message-list${sorting.dragging?" is-sorting":""}`}>{queue.items.map((item,index) => <li key={item.id} data-queue-id={item.id} className={`pending-message ${editor?.id===item.id ? "is-editing" : ""} ${sorting.drop?.id===item.id ? `drop-${sorting.drop.edge}` : ""} ${sorting.dragging===item.id ? "dragging" : ""}`}>
    {queue.items.length>1 && <button type="button" className="pending-message-grip" disabled={blocked || !!editor} data-queue-grip={item.id} aria-label={`拖动排序第 ${index+1} 条消息`} title="拖动排序，或用上下方向键移动" onPointerDown={event=>sorting.start(event,item.id)} onPointerMove={sorting.update} onPointerUp={sorting.finish} onPointerCancel={sorting.cancel} onLostPointerCapture={sorting.cancel} onKeyDown={event=>{if(blocked || editor)return;if(event.key==="Escape"){event.preventDefault();sorting.cancel();}if(event.key==="ArrowUp" && index>0){event.preventDefault();void move(item.id,index-1);}if(event.key==="ArrowDown" && index<queue.items.length-1){event.preventDefault();void move(item.id,index+1);}}}><Glyph name="grip" size={14}/></button>}
    <div className="pending-message-content">{editor?.id===item.id ? <div className="pending-message-editor"><textarea autoFocus aria-label="编辑待发送消息" rows={3} maxLength={100000} value={editor.text} disabled={blocked} onChange={event => setEditor({...editor,text:event.target.value})} onCompositionStart={() => composition.current.start()} onCompositionEnd={() => composition.current.end()} onKeyDown={event => {if (composition.current.ignores(event.nativeEvent)) return;if (isSendKey(event.nativeEvent,sendShortcut)) {event.preventDefault();void saveEdit();}if (event.key==="Escape") {event.preventDefault();finishEditing(editor.id);}}}/><div><span>队列已暂停，编辑完成后可继续发送</span><button type="button" disabled={blocked} onClick={() => finishEditing(editor.id)}>取消</button><button type="button" className="pending-editor-save" disabled={blocked || !editor.text.trim()} onClick={() => void saveEdit()}>保存修改</button></div></div> : <p title={item.text}><MessageText text={item.text} mentions={item.mentions}/></p>}
      {(item.images.length>0 || item.files.length>0) && <div className="pending-message-attachments">{item.images.length>0 && <span>{item.images.length} 张图片</span>}{item.files.map(file => <span key={file.sourceId} title={file.name}><Glyph name="document" size={12}/>{file.name}</span>)}</div>}
    </div>{!editor && <div className="pending-message-actions"><button type="button" className="pending-message-edit" aria-label={`编辑第 ${index+1} 条消息`} data-queue-edit={item.id} title="编辑" disabled={blocked} onClick={() => void edit(item)}><Glyph name="edit" size={14}/></button><button type="button" aria-label={`移除第 ${index+1} 条消息`} title="移除" disabled={blocked} onClick={() => void mutate({operation:"remove",revision:queue.revision,id:item.id})}><Glyph name="close" size={14}/></button></div>}
  </li>)}</ol>
  {queue.paused && !editor && queue.items.length>0 && <div className="pending-queue-recovery"><button type="button" disabled={blocked} aria-label="继续发送队列" onClick={()=>void mutate({operation:"resume",revision:queue.revision})}>继续发送</button></div>}
  {editor && !queue.items.some(item => item.id===editor.id) && <p className="pending-messages-error">此消息已被其他窗口发送或移除。未保存内容：{editor.text}<button type="button" onClick={() => finishEditing(editor.id)}>关闭编辑</button></p>}
 </section>;
}
