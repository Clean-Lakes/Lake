import {useEffect, useRef, useState} from "react";
import "./desktopUpdate.css";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

type UpdateState = {status:string; currentVersion:string; version?:string; message:string; progress?:number; releaseNotes?:string; updateAvailable?:boolean};
type UpdateBridge = {command:(action:"state"|"check"|"install")=>Promise<UpdateState>};
declare global {interface Window {lakeWindowsDesktop?:UpdateBridge}}
const processing = new Set(["checking","downloading","verifying","installing"]);

export function DesktopUpdate() {
  const [bridge] = useState(() => window.lakeWindowsDesktop);
  const [state,setState] = useState<UpdateState>({status:"idle",currentVersion:"",message:"检查 Windows 客户端更新"});
  const [open,setOpen] = useState(false);
  const [seenVersion, setSeenVersion] = useState<string | null>(null);
  const dialog = useRef<HTMLElement>(null);
  const lastFocus = useRef<HTMLElement|null>(null);
  const busy = processing.has(state.status);
  const available = state.updateAvailable ?? state.status === "available";
  const unread = available && !!state.version && state.version !== seenVersion && !open && !["downloading", "verifying", "installing"].includes(state.status);
  useEffect(() => { if (open && available && state.version) setSeenVersion(state.version); }, [open, available, state.version]);

  useEffect(() => {
    if (!bridge) return;
    let active=true;
    const poll = () => {void bridge.command("state").then(next => {if(active)setState(next);}).catch(() => {});};
    poll();const timer=window.setInterval(poll,1000);
    return () => {active=false;window.clearInterval(timer);};
  }, [bridge]);
  useEffect(() => {
    if (!open) return;
    lastFocus.current = document.activeElement as HTMLElement|null;
    dialog.current?.focus();
    const keyboard = (event:KeyboardEvent) => {
      if(event.key==="Escape") {event.preventDefault();event.stopPropagation();setOpen(false);}
      if(event.key!=="Tab") return;
      const nodes=[...(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled),a[href]')||[])];
      const first=nodes[0],last=nodes.at(-1);
      if(event.shiftKey&&(document.activeElement===first||document.activeElement===dialog.current)) {event.preventDefault();last?.focus();}
      else if(!event.shiftKey&&(document.activeElement===last||document.activeElement===dialog.current)) {event.preventDefault();first?.focus();}
    };
    document.addEventListener("keydown",keyboard);
    return () => {document.removeEventListener("keydown",keyboard);lastFocus.current?.focus();};
  }, [open]);
  async function command(action:"check"|"install") {
    try {if(bridge)setState(await bridge.command(action));}
    catch {setState(previous=>({...previous,status:"error",message:"无法执行更新，请重新打开客户端后重试"}));}
  }
  if (!bridge) return null;
  return <>
    <button type="button" className={`desktop-update-entry ${available?"has-update":""} ${unread?"has-unread-update":""}`} onClick={() => {setOpen(true);if(!busy&&!available)void command("check");}} title={state.message} aria-label={available ? `发现新版本 Lake ${state.version || ""}` : "检查更新"}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="M20 7v5h-5M4 17v-5h5"/><path d="M6 7a7 7 0 0 1 12-1l2 3M4 15l2 3a7 7 0 0 0 12-1"/></svg>
      <span>{available?"发现新版本":"检查更新"}</span><small>{state.currentVersion?`v${state.currentVersion}`:"Windows"}</small>{available&&<i aria-hidden="true"/>}
    </button>
    {open&&<div className="modal-scrim desktop-update-scrim" onClick={event=>{if(event.target===event.currentTarget)setOpen(false);}}>
      <section ref={dialog} className="desktop-update-dialog" role="dialog" aria-modal="true" aria-labelledby="desktop-update-title" tabIndex={-1}>
        <div className="desktop-update-heading"><div><h2 id="desktop-update-title">Lake 客户端更新</h2><p>Windows x86_64 · 当前版本 {state.currentVersion||"—"}</p></div><button type="button" className="icon-button" aria-label="关闭更新窗口" onClick={()=>setOpen(false)}>×</button></div>
        <div className={`desktop-update-status status-${state.status}`} aria-live="polite"><span className={`desktop-update-symbol ${busy?"spinning":""}`} aria-hidden="true">{busy?"◌":available?"↓":state.status==="error"?"!":state.status==="current"?"✓":"↻"}</span><div>{available&&<strong>Lake {state.version}</strong>}<p>{state.message}</p></div></div>
        {state.status==="downloading"&&<div className="desktop-update-progress"><progress max={100} value={state.progress??0} aria-label="安装包下载进度"/><span>{state.progress??0}%</span></div>}
        {(available || state.releaseNotes) && <section className="desktop-update-release-notes" aria-label="更新公告"><h3>更新公告 · {state.version || state.currentVersion}</h3><div><ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml>{state.releaseNotes?.trim() || "该版本未提供更新公告。"}</ReactMarkdown></div></section>}
        <p className="desktop-update-note">安装会关闭终端连接并重新打开 Lake，保留用户数据和配置。免安装版更新后使用安装版。</p>
        <div className="desktop-update-actions"><button type="button" className="button secondary" onClick={()=>setOpen(false)}>{busy?"隐藏窗口":"稍后"}</button><button type="button" className="button primary" disabled={busy} onClick={()=>void command(available?"install":"check")}>{busy?state.status==="downloading"?"下载中…":"正在处理…":available?"下载并安装":"检查更新"}</button></div>
      </section>
    </div>}
  </>;
}
