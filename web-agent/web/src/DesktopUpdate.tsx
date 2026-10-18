import {useEffect, useRef, useState} from "react";
import {createPortal} from "react-dom";
import "./desktopUpdate.css";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {Glyph} from "./Icons";
import packageInfo from "../../package.json";
import {checkReleaseAnnouncement,repositoryURL,releasesURL,type UpdateState,type UpdateBridge} from "./desktopUpdateModel";

declare global {interface Window {lakeWindowsDesktop?:UpdateBridge;lakeDesktopUpdates?:UpdateBridge}}
const processing = new Set(["checking","downloading","verifying","installing"]);

export function DesktopUpdate({hideTrigger=false,onUnreadChange}:{hideTrigger?:boolean;onUnreadChange?:(unread:boolean)=>void}={}) {
  const [bridge] = useState(() => window.lakeDesktopUpdates??window.lakeWindowsDesktop);
  const [state,setState] = useState<UpdateState>({status:"idle",currentVersion:packageInfo.version,message:"检查 Lake 更新"});
  const [open,setOpen] = useState(false);
  const [seenVersion, setSeenVersion] = useState<string | null>(null);
  const dialog = useRef<HTMLElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const lastFocus = useRef<HTMLElement|null>(null);
  const readonly=!bridge||bridge.development;
  const platform=bridge?.platform??(window.lakeWindowsDesktop?"Windows x86_64":"浏览器");
  const busy = processing.has(state.status);
  const available = state.updateAvailable ?? state.status === "available";
  const unread = available && !!state.version && state.version !== seenVersion && !open && !["downloading", "verifying", "installing"].includes(state.status);
  useEffect(()=>{onUnreadChange?.(unread);},[unread,onUnreadChange]);
  useEffect(() => { if (open && available && state.version) setSeenVersion(state.version); }, [open, available, state.version]);

  useEffect(() => {
    if (!bridge) return;
    let active=true;
    const poll = () => {void bridge.command("state").then(next => {if(active)setState(next);}).catch(() => {});};
    const updated=(event:Event)=>{const next=(event as CustomEvent<UpdateState>).detail;if(active&&next?.currentVersion&&next.status)setState(next);};
    window.addEventListener("lake-desktop-update",updated);
    poll();const timer=window.setInterval(poll,1000);
    return () => {active=false;window.clearInterval(timer);window.removeEventListener("lake-desktop-update",updated);};
  }, [bridge]);
  useEffect(() => {
    if (!open) return;
    lastFocus.current = trigger.current ?? document.activeElement as HTMLElement|null;
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
  useEffect(()=>{const show=()=>{setOpen(true);if(!busy&&!available)void command("check");};window.addEventListener("lake-open-updates",show);return()=>window.removeEventListener("lake-open-updates",show);},[busy,available]);
  async function command(action:"check"|"install") {
    if(action==="install"&&readonly)return;
    if(action==="check")setState(previous=>({...previous,status:"checking",message:"正在检查更新…"}));
    try {setState(bridge ? await bridge.command(action) : await checkReleaseAnnouncement(state.currentVersion));}
    catch {setState(previous=>({...previous,status:"error",message:"无法检查更新，请稍后重试或打开发布页"}));}
  }
  return <>
    {!hideTrigger&&<button type="button" ref={trigger} className={`icon-button desktop-update-trigger ${unread?"has-unread-update":""}`} onClick={() => {setOpen(true);if(!busy&&!available)void command("check");}} title="检查更新" aria-label={available ? `发现新版本 Lake ${state.version || ""}` : "检查更新"}><Glyph name="refresh" size={17} className={busy?"spinning":""}/>{unread&&<i aria-hidden="true"/>}</button>}
    {open&&createPortal(<div className="modal-scrim desktop-update-scrim" onClick={event=>{if(event.target===event.currentTarget)setOpen(false);}}>
      <section ref={dialog} className="desktop-update-dialog" role="dialog" aria-modal="true" aria-labelledby="desktop-update-title" tabIndex={-1}>
        <div className="desktop-update-heading"><div><h2 id="desktop-update-title">Lake 更新</h2><p>当前版本 v{state.currentVersion||"—"} · {bridge?.development?"本地测试版":platform}</p></div><button type="button" className="icon-button" aria-label="关闭更新窗口" onClick={()=>setOpen(false)}><Glyph name="close" size={16}/></button></div>
        <div className={`desktop-update-status status-${state.status}`} aria-live="polite"><span className={`desktop-update-symbol ${busy?"spinning":""}`} aria-hidden="true"><Glyph name={busy?'refresh':available?'down':state.status==='error'?'alert':state.status==='current'?'check':'refresh'} size={20}/></span><div>{available&&<strong>Lake {state.version}</strong>}<p>{state.message}</p></div></div>
        {state.status==="downloading"&&<div className="desktop-update-progress"><progress max={100} value={state.progress??0} aria-label="安装包下载进度"/><span>{state.progress??0}%</span></div>}
        {<section className="desktop-update-release-notes" aria-label="更新公告"><h3>更新内容{state.version ? ` · ${state.version}` : ""}</h3><div><ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={{a:props=><a {...props} target="_blank" rel="noopener noreferrer"/>}}>{state.releaseNotes?.trim() || (busy?"正在读取更新内容…":state.status==="error"||state.status==="idle"?"暂未取得更新内容。":"该版本未提供更新内容。")}</ReactMarkdown></div></section>}
        <div className="desktop-update-links"><a href={repositoryURL} target="_blank" rel="noopener noreferrer"><Glyph name="code" size={15}/><span>Git 地址<small>github.com/Clean-Lakes/Lake</small></span><Glyph name="arrow" size={14}/></a><a href={releasesURL} target="_blank" rel="noopener noreferrer">查看发布页<Glyph name="arrow" size={13}/></a></div><p className="desktop-update-note">{bridge?.development?"本地测试版通过本地构建更新，正式版与测试版保持独立。":!bridge?"可在发布页查看适合当前系统的安装包。":"安装将关闭终端连接并重新打开 Lake，保留数据和配置。"}</p>
        <div className="desktop-update-actions"><button type="button" className="button secondary" onClick={()=>setOpen(false)}>{busy?"隐藏窗口":"稍后"}</button><button type="button" className="button primary" disabled={busy} onClick={()=>void command(available&&!readonly?"install":"check")}>{busy?state.status==="downloading"?"下载中…":"正在处理…":available&&!readonly?"下载并安装":"重新检查"}</button></div>
      </section>
    </div>,document.body)}
  </>;
}
