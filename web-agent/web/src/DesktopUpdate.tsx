import {useEffect, useRef, useState} from "react";
import "./desktopUpdate.css";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {Glyph} from "./Icons";
import {WorkspacePageHeader} from "./WorkspacePage";
import packageInfo from "../../package.json";
import {checkReleaseAnnouncement,repositoryURL,releasesURL,type UpdateState,type UpdateBridge} from "./desktopUpdateModel";

declare global {interface Window {lakeWindowsDesktop?:UpdateBridge;lakeDesktopUpdates?:UpdateBridge}}
const processing = new Set(["checking","downloading","verifying","installing"]);

export function DesktopUpdate({visible,onUnreadChange}:{
  visible:boolean;onUnreadChange?:(unread:boolean)=>void;
}) {
  const [bridge] = useState(() => window.lakeDesktopUpdates??window.lakeWindowsDesktop);
  const [state,setState] = useState<UpdateState>({status:"idle",currentVersion:packageInfo.version,message:"检查 Lake 更新"});
  const [seenVersion, setSeenVersion] = useState<string | null>(null);
  const checkedOnEntry = useRef(false);
  const readonly=!bridge||bridge.development;
  const platform=bridge?.platform??(window.lakeWindowsDesktop?"Windows x86_64":"浏览器");
  const busy = processing.has(state.status);
  const available = state.updateAvailable ?? state.status === "available";
  const unread = available && !!state.version && state.version !== seenVersion && !visible && !["downloading", "verifying", "installing"].includes(state.status);
  useEffect(()=>{onUnreadChange?.(unread);},[unread,onUnreadChange]);
  useEffect(() => { if (visible && available && state.version) setSeenVersion(state.version); }, [visible, available, state.version]);

  useEffect(() => {
    if (!bridge) return;
    let active=true;
    const poll = () => {void bridge.command("state").then(next => {if(active)setState(next);}).catch(() => {});};
    const updated=(event:Event)=>{const next=(event as CustomEvent<UpdateState>).detail;if(active&&next?.currentVersion&&next.status)setState(next);};
    window.addEventListener("lake-desktop-update",updated);
    poll();const timer=window.setInterval(poll,1000);
    return () => {active=false;window.clearInterval(timer);window.removeEventListener("lake-desktop-update",updated);};
  }, [bridge]);
  useEffect(()=>{
    if(!visible){checkedOnEntry.current=false;return;}
    if(checkedOnEntry.current)return;
    checkedOnEntry.current=true;
    if(!busy&&!available)void command("check");
  },[visible,busy,available]);
  async function command(action:"check"|"install") {
    if(action==="install"&&readonly)return;
    if(action==="check")setState(previous=>({...previous,status:"checking",message:"正在检查更新…"}));
    try {setState(bridge ? await bridge.command(action) : await checkReleaseAnnouncement(state.currentVersion));}
    catch {setState(previous=>({...previous,status:"error",message:"无法检查更新，请稍后重试或打开发布页"}));}
  }
  if(!visible)return null;
  const actionLabel=busy?state.status==="downloading"?"下载中…":"正在处理…":available&&!readonly?"下载并安装":"重新检查";
  return <section id="workspace-updates-page" className="workspace-page desktop-update-page" role="tabpanel" aria-labelledby="updates-console-tab">
      <WorkspacePageHeader id="desktop-update-title" title="检查更新" actions={
        <button type="button" className="button primary" aria-label={actionLabel} title={actionLabel} disabled={busy}
          onClick={()=>void command(available&&!readonly?"install":"check")}><Glyph name={available&&!readonly?'down':'refresh'} size={15}/><span>{actionLabel}</span></button>
      }/>
      <div className="desktop-update-layout">
        <div className="desktop-update-status-card workspace-setting-card">
            <div className={`desktop-update-status status-${state.status}`} aria-live="polite">
              <span className="desktop-update-symbol" aria-hidden="true"><Glyph className={busy?"spinning":undefined} name={busy?'refresh':available?'down':state.status==='error'?'alert':state.status==='current'?'check':'refresh'} size={20}/></span>
              <div>
                <strong>Lake {state.currentVersion || "—"}</strong>
                <p className="desktop-update-version">{bridge?.development?"本地测试版":platform}{available&&state.version? ` · 可更新至 ${state.version}`:""}</p>
              </div>
            </div>
            <p className={`desktop-update-message status-${state.status}`} role="status">{state.message}</p>
            {state.status==="downloading"&&<div className="desktop-update-progress"><progress max={100} value={state.progress??0} aria-label="安装包下载进度"/><span>{state.progress??0}%</span></div>}
        </div>
        <section className="desktop-update-release-notes" aria-labelledby="desktop-update-notes-title">
          <h2 id="desktop-update-notes-title" className="workspace-section-title">更新内容{state.version ? ` · ${state.version}` : ""}</h2>
          <div className="desktop-update-notes-copy workspace-setting-card">
            <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={{a:props=><a {...props} target="_blank" rel="noopener noreferrer"/>}}>{state.releaseNotes?.trim() || (busy?"正在读取更新内容…":state.status==="error"||state.status==="idle"?"暂未取得更新内容。":"该版本未提供更新内容。")}</ReactMarkdown>
          </div>
        </section>
        <div className="desktop-update-details">
          <nav className="desktop-update-links workspace-setting-card" aria-label="更新链接">
            <a href={releasesURL} target="_blank" rel="noopener noreferrer"><Glyph name="layers" size={15}/><span>查看发布页</span><Glyph name="arrow" size={14}/></a>
            <a href={repositoryURL} target="_blank" rel="noopener noreferrer"><Glyph name="code" size={15}/><span>源代码<small>github.com/Clean-Lakes/Lake</small></span><Glyph name="arrow" size={14}/></a>
          </nav>
          <p className="desktop-update-note">{bridge?.development?"本地测试版通过本地构建更新。":!bridge?"可在发布页查看适合当前系统的安装包。":"安装将关闭终端连接并重新打开 Lake，保留数据和配置。"}</p>
        </div>
      </div>
    </section>;
}
