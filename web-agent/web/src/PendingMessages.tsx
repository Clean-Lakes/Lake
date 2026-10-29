import {MessageText} from './MessageText';
import {rebaseMessageMentions} from './messageMentions';
import {Glyph} from './Icons';
import {rebaseExtensionReferences} from "../../shared/references";
import {useCallback,useEffect,useLayoutEffect,useRef,useState} from "react";
import type {MessageQueue,QueueOperation,QueuedMessage,MessageMention} from "../../shared/contracts";
import {api,readableError} from "./api";
import {CompositionGuard,isSendKey,type SendShortcut} from "./composerKeyboard";
import {reorderQueuedMessages} from "./messageQueue";
import {useQueueDrag} from "./useQueueDrag";
import {reconcileQueuePresence,type QueuePresence} from "./queuePresence";
import {QueueMessagePresence,queueMotionEnabled} from "./QueueMessagePresence";
import "./pendingMessages.css";

export function PendingMessages({sessionId,queue,disabled,active,sendShortcut,resourceIds,onUpdated}: {
 sessionId:string;queue:MessageQueue;disabled:boolean;active:boolean;sendShortcut:SendShortcut;resourceIds:(text:string)=>string[];onUpdated:(queue:MessageQueue)=>void;
}) {
 const [busy,setBusy]=useState(false);
 const [error,setError]=useState("");
 const [editor,setEditor]=useState<{id:string;text:string;original:string;references:Record<string,unknown>[];mentions:MessageMention[]} | null>(null);

 const [presentation,setPresentation]=useState(()=>({source:queue.items,rows:queue.items.map(item=>({item,phase:'present' as const})) as QueuePresence[]}));
 if(presentation.source!==queue.items)setPresentation({source:queue.items,rows:reconcileQueuePresence(presentation.rows,queue.items,queueMotionEnabled())});
 const settle=useCallback((id:string,phase:QueuePresence['phase'])=>setPresentation(current=>({...current,rows:current.rows.flatMap(row=>row.item.id!==id||row.phase!==phase?[row]:phase==='leaving'?[]:[{...row,phase:'present'}])})),[]);
 useEffect(()=>{
  const reduce=window.matchMedia('(prefers-reduced-motion: reduce)');
  const settleAll=()=>{if(!queueMotionEnabled()){moves.current.forEach(animation=>animation.cancel());setPresentation(current=>({...current,rows:current.rows.filter(row=>row.phase!=='leaving').map(row=>({...row,phase:'present'}))}));}};
  reduce.addEventListener('change',settleAll);document.addEventListener('visibilitychange',settleAll);
  return ()=>{reduce.removeEventListener('change',settleAll);document.removeEventListener('visibilitychange',settleAll);};
 },[]);
 const positions=useRef<{order:string;tops:Map<string,number>}>({order:'',tops:new Map()});
 const moves=useRef<Animation[]>([]);
 useLayoutEffect(()=>{
  const nodes=[...(sorting.list.current?.querySelectorAll<HTMLElement>('.pending-message-presence')??[])];
  const order=queue.items.map(item=>item.id).join('\0');
  const tops=new Map(nodes.map(node=>[node.querySelector<HTMLElement>('[data-queue-id]')?.dataset.queueId??'',node.offsetTop]));
  const previous=positions.current;
  if(previous.order!==order&&previous.tops.size===tops.size&&presentation.rows.every(row=>row.phase==='present')&&queueMotionEnabled()){
   const offsets=new Map(nodes.map(node=>{const transform=getComputedStyle(node).transform;return [node,transform==='none'?0:new DOMMatrixReadOnly(transform).m42];}));
   moves.current.forEach(animation=>animation.cancel());moves.current=[];
   nodes.forEach(node=>{const id=node.querySelector<HTMLElement>('[data-queue-id]')?.dataset.queueId??'';const before=previous.tops.get(id);if(before===undefined)return;const delta=before+(offsets.get(node)??0)-node.offsetTop;if(delta)moves.current.push(node.animate([{transform:`translateY(${delta}px)`},{transform:'translateY(0)'}],{duration:260,easing:'cubic-bezier(.22,1,.36,1)'}));});
  }
  positions.current={order,tops};
 });
 useEffect(()=>()=>{moves.current.forEach(animation=>animation.cancel());},[]);
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
 async function push(item:QueuedMessage) {
  const next=await mutate({operation:"push",revision:queue.revision,id:item.id});
  if(next)panel.current?.closest(".session-view")?.querySelector<HTMLElement>("#message-input")?.focus({preventScroll:true});
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
 const hasContent=!!(presentation.rows.length || editor || error);
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
  <span className="visually-hidden" role="status">{queue.items.length} 条 · {queue.items.some(item=>item.supplementRootTurnId)?"有消息等待补充本轮":queue.paused ? "已暂停" : active ? "本轮结束后发送" : "按顺序发送"}</span>
  {queue.lastError && <p className="pending-messages-note" role="status">{queue.lastError}</p>}{error && <p className="pending-messages-error" role="alert">{error}</p>}
  <ol ref={sorting.list} className={`pending-message-list${sorting.dragging?" is-sorting":""}`}>{presentation.rows.map(({item,phase}) => {const index=queue.items.findIndex(row=>row.id===item.id);const retiring=phase==='leaving';const pushing=!!item.supplementRootTurnId;return <QueueMessagePresence key={item.id} id={item.id} phase={phase} onSettled={settle}><div data-queue-id={retiring?undefined:item.id} className={`pending-message ${editor?.id===item.id ? "is-editing" : ""} ${sorting.drop?.id===item.id ? `drop-${sorting.drop.edge}` : ""} ${sorting.dragging===item.id ? "dragging" : ""}`}>
    <button type="button" className="pending-message-grip" disabled={blocked || retiring || pushing || !!editor || queue.items.length<2} data-queue-grip={item.id} aria-label={`拖动排序第 ${index+1} 条消息`} title="拖动排序，或用上下方向键移动" onPointerDown={event=>sorting.start(event,item.id)} onPointerMove={sorting.update} onPointerUp={sorting.finish} onPointerCancel={sorting.cancel} onLostPointerCapture={sorting.cancel} onKeyDown={event=>{if(blocked || editor)return;if(event.key==="Escape"){event.preventDefault();sorting.cancel();}if(event.key==="ArrowUp" && index>0){event.preventDefault();void move(item.id,index-1);}if(event.key==="ArrowDown" && index<queue.items.length-1){event.preventDefault();void move(item.id,index+1);}}}><Glyph name="grip" size={14}/></button>
    <div className="pending-message-content">{editor?.id===item.id ? <div className="pending-message-editor"><textarea autoFocus aria-label="编辑待发送消息" rows={3} maxLength={100000} value={editor.text} disabled={blocked} onChange={event => setEditor({...editor,text:event.target.value})} onCompositionStart={() => composition.current.start()} onCompositionEnd={() => composition.current.end()} onKeyDown={event => {if (composition.current.ignores(event.nativeEvent)) return;if (isSendKey(event.nativeEvent,sendShortcut)) {event.preventDefault();void saveEdit();}if (event.key==="Escape") {event.preventDefault();finishEditing(editor.id);}}}/><div><span>队列已暂停，编辑完成后可继续发送</span><button type="button" disabled={blocked} onClick={() => finishEditing(editor.id)}>取消</button><button type="button" className="pending-editor-save" disabled={blocked || !editor.text.trim()} onClick={() => void saveEdit()}>保存修改</button></div></div> : <p title={item.text}><MessageText text={item.text} mentions={item.mentions}/></p>}
      {pushing&&<small className="pending-message-push-status" role="status">待补充 · 当前步骤结束后接入</small>}
      {(item.images.length>0 || item.files.length>0) && <div className="pending-message-attachments">{item.images.length>0 && <span>{item.images.length} 张图片</span>}{item.files.map(file => <span key={file.sourceId} title={file.name}><Glyph name="document" size={12}/>{file.name}</span>)}</div>}
    </div>{!editor && <div className="pending-message-actions"><button type="button" className="pending-message-push" aria-label={`推送第 ${index+1} 条消息到本轮`} title={pushing?"待补充，当前步骤结束后接入":active?"推送到当前任务，当前步骤结束后补充":"本轮运行时可补充；空闲时请继续发送队列"} aria-busy={pushing} disabled={blocked || retiring || pushing || !active} onClick={()=>void push(item)}><Glyph name={pushing?"loader":"up"} className={pushing?"pending-message-push-loader":""} size={15}/></button><button type="button" className="pending-message-edit" aria-label={`编辑第 ${index+1} 条消息`} data-queue-edit={item.id} title="编辑" disabled={blocked || retiring || pushing} onClick={() => void edit(item)}><Glyph name="edit" size={14}/></button><button type="button" aria-label={`移除第 ${index+1} 条消息`} title="移除" disabled={blocked || retiring || pushing} onClick={() => void mutate({operation:"remove",revision:queue.revision,id:item.id})}><Glyph name="close" size={14}/></button></div>}
  </div></QueueMessagePresence>})}</ol>
  {queue.paused && !editor && queue.items.length>0 && <div className="pending-queue-recovery"><button type="button" disabled={blocked} aria-label="继续发送队列" onClick={()=>void mutate({operation:"resume",revision:queue.revision})}>继续发送</button></div>}
  {editor && !queue.items.some(item => item.id===editor.id) && <p className="pending-messages-error">此消息已被其他窗口发送或移除。未保存内容：{editor.text}<button type="button" onClick={() => finishEditing(editor.id)}>关闭编辑</button></p>}
 </section>;
}
