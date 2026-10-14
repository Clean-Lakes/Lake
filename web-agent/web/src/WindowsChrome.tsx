import {useEffect, useState} from "react";
import "./windowsChrome.css";

type ChromeAction = "state" | "drag" | "minimize" | "maximize" | "close";
type ChromeBridge = {command: (action: ChromeAction) => Promise<string>};

declare global {interface Window {lakeWindowsChrome?: ChromeBridge}}

export function WindowsChrome() {
  const [bridge] = useState(() => window.lakeWindowsChrome);
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!bridge) return;
    const refresh = () => {void bridge.command("state").then(state => setMaximized(state === "maximized")).catch(() => {});};
    const drag = (event: PointerEvent) => {
      if (event.button !== 0 || !(event.target instanceof Element)) return;
      const target = event.target;
      if (target.closest('button,a,input,select,textarea,[role="button"],[contenteditable="true"],.workbench-splitter,.windows-titlebar-controls')) return;
      const header = target.closest(".sidebar-brand-row,.workspace-header,.terminal-panel-header");
      if (!header && (document.querySelector(".app-shell") || event.clientY >= 48)) return;
      event.preventDefault();
      void bridge.command(event.detail >= 2 ? "maximize" : "drag");
    };
    refresh();
    window.addEventListener("resize", refresh);
    document.addEventListener("pointerdown", drag, true);
    return () => {window.removeEventListener("resize", refresh);document.removeEventListener("pointerdown", drag, true);};
  }, [bridge]);

  if (!bridge) return null;
  const run = (action: ChromeAction) => {void bridge.command(action).catch(() => {});};
  return <div className="windows-titlebar-controls" role="group" aria-label="窗口操作">
    <button type="button" title="最小化" aria-label="最小化窗口" onClick={() => run("minimize")}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8.5h10"/></svg></button>
    <button type="button" title={maximized ? "还原" : "最大化"} aria-label={maximized ? "还原窗口" : "最大化窗口"} onClick={() => run("maximize")}><svg viewBox="0 0 16 16" aria-hidden="true">{maximized ? <path d="M5 4.5h7v7H5zM4 11.5H3v-9h8v1"/> : <path d="M3.5 3.5h9v9h-9z"/>}</svg></button>
    <button type="button" className="windows-close" title="关闭" aria-label="关闭窗口" onClick={() => run("close")}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 3.5l9 9m0-9-9 9"/></svg></button>
  </div>;
}
