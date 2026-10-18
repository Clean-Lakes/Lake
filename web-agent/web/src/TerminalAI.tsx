import {Glyph} from './Icons';
import { useEffect, useRef, useState, type FormEvent } from "react";
import type { AIImage, SessionSnapshot, TerminalSession } from "../../shared/contracts";
import { AIControls, AITranscript, ContextReferencePicker } from "./AIPanel";
import { api, readableError } from "./api";
import { readImageSelection, clipboardImageFiles } from "./imageAttachments";
import { sameTerminalBinding, terminalTurnActive, type TerminalBinding } from "./terminalAIState";

export function TerminalAI({ session, terminal, onClose }: { session: string; terminal: TerminalSession; onClose: () => void }) {
 const [binding,setBinding]=useState<(TerminalBinding & {needsAdoption:boolean;shellRecreated:boolean;ownerTitle:string})|null>(null);
 const [snapshot,setSnapshot]=useState<SessionSnapshot|null>(null),[message,setMessage]=useState(""),[error,setError]=useState(""),[busy,setBusy]=useState(false),[options,setOptions]=useState(false);
 const [permissions,setPermissions]=useState(false);const anchor=useRef<HTMLButtonElement>(null),current=useRef<TerminalBinding|null>(null);
 const [images,setImages]=useState<AIImage[]>([]),[references,setReferences]=useState<Record<string,unknown>[]>([]),[imageSupported,setImageSupported]=useState(false);
 const imageInput=useRef<HTMLInputElement>(null),readingImage=useRef(false);
 const [attaching,setAttaching]=useState(false);
 useEffect(()=>{let disposed=false;void api.bootstrap().then(value=>{if(!disposed)setImageSupported(value.supportsImageInput===true)}).catch(()=>{});return()=>{disposed=true}},[binding?.sessionId]);
 useEffect(()=>{let cancelled=false;setError("");void api.terminalAIScope(session,terminal.id,terminal.generation).then(value=>{if(!cancelled){current.current=value;setBinding(value)}}).catch(e=>{if(!cancelled)setError(readableError(e))});return()=>{cancelled=true;current.current=null}},[session,terminal.id,terminal.generation]);
 const refresh=async()=>{if(!binding)return;const value=await api.snapshot(binding.sessionId);if(current.current&&sameTerminalBinding(current.current,binding))setSnapshot(value);return value};
 useEffect(()=>{
  if(!binding)return;let disposed=false,syncing=false;const requests=new AbortController();
  const fetch=async()=>{if(syncing||disposed)return;syncing=true;try{const value=await api.snapshot(binding.sessionId,requests.signal);if(!disposed&&current.current&&sameTerminalBinding(current.current,binding))setSnapshot(value)}catch(e){if(!disposed)setError(readableError(e))}finally{syncing=false}};
  void fetch();const stream=new EventSource(api.eventsUrl(binding.sessionId,0),{withCredentials:true});for(const event of ["session","message","terminal","action"])stream.addEventListener(event,()=>void fetch());const poll=setInterval(()=>void fetch(),2000);
  return()=>{disposed=true;requests.abort();stream.close();clearInterval(poll)};
 },[binding]);
 const active=terminalTurnActive(snapshot?.ai?.status) || snapshot?.session.status === "investigating" || snapshot?.session.status === "waiting_approval";
 const work=async(fn:()=>Promise<unknown>)=>{setBusy(true);setError("");try{await fn();await refresh()}catch(e){setError(readableError(e))}finally{setBusy(false)}};
 const adopt=()=>work(async()=>{if(!binding)return;await api.adoptTerminal(binding.sessionId,binding.terminalId,binding.generation,true);setBinding({...binding,needsAdoption:false})});
 const bound=snapshot?.terminals.find(t=>t.id===terminal.id);
 useEffect(()=>{if(binding && !binding.needsAdoption && snapshot && !bound && terminal.status!=="disconnected")setBinding(current=>current?{...current,needsAdoption:true}:current)},[binding,snapshot,bound,terminal.status]);
 const attach=async(files:FileList|File[]|null)=>{if(!files||!binding||readingImage.current)return;readingImage.current=true;setAttaching(true);setError("");const origin=binding;try{const added=await readImageSelection(images,[...files]);if(current.current&&sameTerminalBinding(current.current,origin))setImages(existing=>[...existing,...added])}catch(e){if(current.current&&sameTerminalBinding(current.current,origin))setError(readableError(e))}finally{readingImage.current=false;setAttaching(false);if(imageInput.current)imageInput.current.value=""}};
 const send=(event:FormEvent)=>{event.preventDefault();if(!binding||(!message.trim()&&!images.length)||active||binding.needsAdoption||busy||attaching||images.length>0&&!imageSupported)return;const text=message.trim();void work(async()=>{await api.sendMessage(binding.sessionId,text,[],images,references);if(current.current&&sameTerminalBinding(current.current,binding)){setMessage("");setImages([]);setReferences([])}})};
 const draftDisabled=!binding||binding.needsAdoption||busy||attaching||active||terminal.status==="disconnected";
 return <section className="terminal-ai" aria-label="当前终端 AI"><div className="terminal-ai-heading"><strong>终端 AI</strong><button type="button" onClick={()=>setOptions(true)}>会话设置</button><button type="button" ref={anchor} onClick={()=>setPermissions(!permissions)}>权限</button><button type="button" onClick={onClose}>收起</button></div>
 <p>此资源的 AI 历史会保留。当前 Shell：{terminal.shell} · {bound?.cwd || terminal.cwd || "目录待采集"}</p>
 {binding?.shellRecreated&&<p role="status">Shell 已重建：历史会保留，当前目录与环境来自新终端，不继承旧 Shell。</p>}
 {active&&snapshot?.aiBinding?.terminalId!==terminal.id&&<p role="status">AI 本轮仍绑定原终端。先停止本轮，再允许绑定当前终端。</p>}
 {terminal.status==="disconnected"&&<p role="status">终端已关闭；这里只保留历史记录。新终端的目录与环境不会继承。</p>}
 {binding?.needsAdoption&&<div className="terminal-ai-adoption"><p>访问「{binding.ownerTitle}」拥有的这个终端需要授权。授权后可读取终端；执行命令还需明确交给 Agent。</p><button type="button" disabled={busy||active||terminal.status==="disconnected"} onClick={()=>void adopt()}>允许访问并绑定此终端</button></div>}
 {error&&<p role="alert" className="form-error">{error}</p>}
 {snapshot?.ai&&<><div className="terminal-ai-transcript"><AITranscript snapshot={snapshot}/></div><AIControls snapshot={snapshot} refresh={refresh} optionsOpen={options} onCloseOptions={()=>setOptions(false)} permissionsOpen={permissions} permissionAnchor={anchor} onClosePermissions={()=>setPermissions(false)}/></>}
 {binding&&!binding.needsAdoption&&(bound?.holder!=="agent" || bound?.writerSessionId!==binding.sessionId)&&terminal.status!=="disconnected"&&<button type="button" disabled={busy||active||bound?.status!=="ready"} onClick={()=>void work(()=>api.terminalControl(binding.sessionId,terminal.id,"agent"))}>将空闲终端交给此 Agent</button>}
 <form onSubmit={send}>{images.length>0&&<div className="image-drafts">{images.map(image=><figure key={image.id}><img src={`data:${image.mimeType};base64,${image.base64}`} alt={image.name||"待发送图片"}/><figcaption title={image.name}>{image.name||"剪贴板图片"}</figcaption><button type="button" disabled={draftDisabled} aria-label={`移除 ${image.name||"图片"}`} onClick={()=>setImages(current=>current.filter(value=>value.id!==image.id))}><Glyph name="close" size={14}/></button></figure>)}</div>}{references.length>0&&<div className="reference-chips">{references.map((reference,index)=><span key={index}>{String(reference.label||reference.path||reference.table||reference.terminal_id||"上下文引用")}<button type="button" disabled={draftDisabled} aria-label={`移除上下文引用 ${index+1}`} onClick={()=>setReferences(current=>current.filter((_,at)=>at!==index))}><Glyph name="close" size={14}/></button></span>)}</div>}{images.length>0&&!imageSupported&&<p className="composer-image-hint" role="status">已检测到当前模型不接受图片输入，请切换模型或在模型设置中手动调整。</p>}<label>询问当前终端<textarea value={message} onPaste={event=>{const files=clipboardImageFiles(event.clipboardData);if(!files.length)return;event.preventDefault();void attach(files)}} onChange={e=>setMessage(e.target.value)} maxLength={100000} disabled={draftDisabled}/></label><div className="terminal-ai-actions"><input ref={imageInput} className="visually-hidden" type="file" multiple accept="image/png,image/jpeg,image/gif,image/webp" onChange={e=>void attach(e.target.files)}/><button type="button" disabled={draftDisabled} title="添加图片，也可直接粘贴截图" onClick={()=>imageInput.current?.click()}>图片</button>{snapshot&&!draftDisabled&&<ContextReferencePicker snapshot={snapshot} onAdd={reference=>{if(references.length>=40){setError("最多 40 项上下文引用");return}setReferences(current=>[...current,reference])}}/>}{active?<button type="button" disabled={busy} onClick={()=>void work(()=>api.aiOperation(binding!.sessionId,"abort"))}>停止本轮</button>:<button disabled={draftDisabled||(!message.trim()&&!images.length)||images.length>0&&!imageSupported}>发送</button>}</div></form>
 </section>
}
