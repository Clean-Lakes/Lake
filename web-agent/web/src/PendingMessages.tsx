import {rebaseExtensionReferences} from "../../shared/references";
import {useRef,useState} from "react";
import type {MessageQueue,QueueOperation,QueuedMessage} from "../../shared/contracts";
import {api,readableError} from "./api";
import {CompositionGuard,isSendKey,type SendShortcut} from "./composerKeyboard";
import {reorderQueuedMessages} from "./messageQueue";
import "./pendingMessages.css";

export function PendingMessages({sessionId,queue,disabled,active,sendShortcut,resourceIds,onUpdated}: {
 sessionId:string;queue:MessageQueue;disabled:boolean;active:boolean;sendShortcut:SendShortcut;resourceIds:(text:string)=>string[];onUpdated:(queue:MessageQueue)=>void;
}) {
 const [busy,setBusy]=useState(false);
 const [error,setError]=useState("");
 const [editor,setEditor]=useState<{id:string;text:string;original:string;references:Record<string,unknown>[]} | null>(null);
 const [dragging,setDragging]=useState<string|null>(null);
 const [dragOver,setDragOver]=useState<string|null>(null);
 const composition=useRef(new CompositionGuard());
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
  setEditor({id:pending.id,text:pending.text,original:pending.text,references:pending.references??[]});composition.current=new CompositionGuard();
 }
 async function saveEdit() {
  if (!editor?.text.trim()) return;
  const next=await mutate({operation:"edit",revision:queue.revision,id:editor.id,text:editor.text.trim(),resourceIds:queue.items.find(item=>item.id===editor.id)?.resourceIds??resourceIds(editor.text),references:rebaseExtensionReferences(editor.original,editor.text.trim(),editor.references)});
  if (next) setEditor(null);
 }
 async function move(id:string,position:number) {
  const ids=queue.items.map(item => item.id);
  const next=reorderQueuedMessages(ids,id,position);
  if (next!==ids && next.some((value,index) => value!==ids[index])) await mutate({operation:"reorder",revision:queue.revision,ids:next});
 }
 if (!queue.items.length && !editor && !error) return null;
 const blocked=disabled || busy;
 return <section className="pending-messages" aria-label="待发送消息"><div className="pending-messages-header"><div><strong>待发送 <span>{queue.items.length}</span></strong><small>{queue.paused ? "已暂停" : active ? "本轮结束后依次发送" : "按顺序发送"}</small></div><button type="button" disabled={blocked || !!editor} onClick={() => void mutate({operation:queue.paused ? "resume" : "pause",revision:queue.revision})}>{queue.paused ? "继续发送" : "暂停队列"}</button></div>
  {queue.lastError && <p className="pending-messages-note" role="status">{queue.lastError}</p>}{error && <p className="pending-messages-error" role="alert">{error}</p>}
  <ol className="pending-message-list">{queue.items.map((item,index) => <li key={item.id} className={`pending-message ${dragOver===item.id ? "drop-target" : ""} ${dragging===item.id ? "dragging" : ""}`} onDragOver={event => {if (dragging && dragging!==item.id && !blocked && !editor) {event.preventDefault();event.dataTransfer.dropEffect="move";setDragOver(item.id);}}} onDragLeave={() => setDragOver(null)} onDrop={event => {event.preventDefault();if (dragging && !blocked && !editor) void move(dragging,index);setDragging(null);setDragOver(null);}}>
    <span className="pending-message-grip" role="button" tabIndex={blocked || !!editor ? -1 : 0} aria-label={`拖动排序第 ${index+1} 条消息`} title="拖动排序，或用上下方向键移动" draggable={!blocked && !editor} onDragStart={event => {if (blocked || editor) {event.preventDefault();return;}event.dataTransfer.setData("text/plain",item.id);event.dataTransfer.effectAllowed="move";setDragging(item.id);}} onDragEnd={() => {setDragging(null);setDragOver(null);}} onKeyDown={event => {if (blocked || editor) return;if (event.key==="ArrowUp" && index>0) {event.preventDefault();void move(item.id,index-1);}if (event.key==="ArrowDown" && index<queue.items.length-1) {event.preventDefault();void move(item.id,index+1);}}}>⠿</span>
    <div className="pending-message-content">{editor?.id===item.id ? <div className="pending-message-editor"><textarea autoFocus aria-label="编辑待发送消息" rows={3} maxLength={100000} value={editor.text} disabled={blocked} onChange={event => setEditor({...editor,text:event.target.value})} onCompositionStart={() => composition.current.start()} onCompositionEnd={() => composition.current.end()} onKeyDown={event => {if (composition.current.ignores(event.nativeEvent)) return;if (isSendKey(event.nativeEvent,sendShortcut)) {event.preventDefault();void saveEdit();}if (event.key==="Escape") {event.preventDefault();setEditor(null);}}}/><div><span>队列已暂停，编辑完成后可继续发送</span><button type="button" disabled={blocked} onClick={() => setEditor(null)}>取消</button><button type="button" className="pending-editor-save" disabled={blocked || !editor.text.trim()} onClick={() => void saveEdit()}>保存修改</button></div></div> : <p title={item.text}>{item.text}</p>}
      {(item.images.length>0 || item.files.length>0) && <div className="pending-message-attachments">{item.images.length>0 && <span>{item.images.length} 张图片</span>}{item.files.map(file => <span key={file.sourceId}>▧ {file.name}</span>)}</div>}
    </div>{!editor && <div className="pending-message-actions"><button type="button" aria-label={`上移第 ${index+1} 条消息`} title="上移" disabled={blocked || index===0} onClick={() => void move(item.id,index-1)}>↑</button><button type="button" aria-label={`下移第 ${index+1} 条消息`} title="下移" disabled={blocked || index===queue.items.length-1} onClick={() => void move(item.id,index+1)}>↓</button><button type="button" aria-label={`编辑第 ${index+1} 条消息`} title="编辑" disabled={blocked} onClick={() => void edit(item)}>✎</button><button type="button" aria-label={`移除第 ${index+1} 条消息`} title="移除" disabled={blocked} onClick={() => void mutate({operation:"remove",revision:queue.revision,id:item.id})}>×</button></div>}
  </li>)}</ol>
  {editor && !queue.items.some(item => item.id===editor.id) && <p className="pending-messages-error">此消息已被其他窗口发送或移除。未保存内容：{editor.text}<button type="button" onClick={() => setEditor(null)}>关闭编辑</button></p>}
 </section>;
}
