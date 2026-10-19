import {useEffect, useState} from "react";
import "./windowsChrome.css";
import {windowGestures} from "./windowGestures";

type ChromeAction = "state" | "drag" | "minimize" | "maximize" | "close";
type ChromeBridge = {command: (action: ChromeAction) => Promise<string>};

declare global {interface Window {lakeWindowsChrome?: ChromeBridge}}

export function WindowsChrome() {
  const [bridge] = useState(() => window.lakeWindowsChrome);
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!bridge) return;
    const refresh = () => {void bridge.command("state").then(state => setMaximized(state === "maximized")).catch(() => {});};
    const gestures = windowGestures(event => {
      const target = (event as MouseEvent).target;
      if (!(target instanceof Element)) return false;
      if (target.closest('button,a,input,select,textarea,[role="button"],[contenteditable="true"],.workbench-splitter,.windows-titlebar-controls,.modal-scrim,dialog,[role="dialog"],[role="menu"],[role="listbox"]')) return false;
      const header = target.closest(".sidebar-brand-row,.workspace-header,.terminal-panel-header");
      return !!header || (event.clientY >= 0 && event.clientY < 48);
    }, action => {void bridge.command(action).then(refresh).catch(() => {});});
    refresh();
    window.addEventListener("resize", refresh);
    document.addEventListener("mousedown", gestures.down, true);
    document.addEventListener("mousemove", gestures.move, true);
    document.addEventListener("mouseup", gestures.cancel, true);
    document.addEventListener("dblclick", gestures.doubleClick, true);
    window.addEventListener("blur", gestures.cancel);
    return () => {window.removeEventListener("resize", refresh);window.removeEventListener("blur", gestures.cancel);document.removeEventListener("mousedown", gestures.down, true);document.removeEventListener("mousemove", gestures.move, true);document.removeEventListener("mouseup", gestures.cancel, true);document.removeEventListener("dblclick", gestures.doubleClick, true);};
  }, [bridge]);

  if (!bridge) return null;
  const run = (action: ChromeAction) => {void bridge.command(action).catch(() => {});};
  return <div className="windows-titlebar-controls" role="group" aria-label="窗口操作">
    <button type="button" title="最小化" aria-label="最小化窗口" onClick={() => run("minimize")}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8.5h10"/></svg></button>
    <button type="button" title={maximized ? "还原" : "最大化"} aria-label={maximized ? "还原窗口" : "最大化窗口"} onClick={() => run("maximize")}><svg viewBox="0 0 16 16" aria-hidden="true">{maximized ? <path d="M5 4.5h7v7H5zM4 11.5H3v-9h8v1"/> : <path d="M3.5 3.5h9v9h-9z"/>}</svg></button>
    <button type="button" className="windows-close" title="收起到后台" aria-label="收起到后台" onClick={() => run("close")}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 3.5l9 9m0-9-9 9"/></svg></button>
  </div>;
}
