import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";

export const permissionDefaults = {
  silentReadFiles: true,
  silentWriteFiles: false,
  silentReadSQL: true,
  silentCommands: true,
  silentTerminalCreation: true,
  blockUnreferencedAssets: false,
  denyLocalExecution: false,
};

const fields: Array<{key: keyof typeof permissionDefaults; label: string; description: string}> = [
  {key: "silentReadFiles", label: "静默读取文件", description: "关闭后，列目录、搜索和读取文件工具需要确认。"},
  {key: "silentWriteFiles", label: "静默修改文件", description: "允许编辑、追加和写入文件；删除和移动由静默执行命令控制。"},
  {key: "silentReadSQL", label: "静默执行只读 SQL", description: "关闭后，只读 SQL 和结构查询执行前需要确认。"},
  {key: "silentCommands", label: "静默执行命令", description: "开启后，查询、修改、指定文件删除和移动及所需终端创建直接执行。仅大范围删除、磁盘擦除等毁灭性操作仍需确认。"},
  {key: "silentTerminalCreation", label: "自动创建终端会话", description: "允许新建或关闭后重建终端；静默执行命令开启时也允许创建。首次 SSH 指纹仍须核对。"},
  {key: "blockUnreferencedAssets", label: "拦截未 @ 引用资产", description: "每一轮仅操作本轮 @ 或上下文引用的资源。"},
  {key: "denyLocalExecution", label: "禁止本地执行", description: "禁止 Agent 在本机执行命令或创建终端；SSH 主机不受此项限制。"},
];

export function PermissionSettings({anchor, options, disabled, error, onChange, onClose}: {
  anchor: RefObject<HTMLButtonElement | null>;
  options: Record<string, unknown>; disabled: boolean; error?: string;
  onChange: (key: string, value: boolean) => void; onClose: () => void;
}) {
  const panel = useRef<HTMLElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  const [position, setPosition] = useState({left: 0, top: 0, maxHeight: 360, ready: false});
  useLayoutEffect(() => {
    const update = () => {
      const trigger = anchor.current; const content = panel.current;
      if (!trigger || !content) return;
      const rect = trigger.getBoundingClientRect(); const gap = 10; const edge = 12;
      const above = rect.top - gap - edge;
      const below = window.innerHeight - rect.bottom - gap - edge;
      const upward = above >= Math.min(content.scrollHeight, 360) || above >= below;
      const maxHeight = Math.max(0, upward ? above : below);
      const height = Math.min(content.scrollHeight, maxHeight);
      setPosition({left: Math.max(edge, Math.min(rect.left - 8, window.innerWidth - content.offsetWidth - edge)),
        top: Math.max(edge, upward ? rect.top - gap - height : rect.bottom + gap), maxHeight, ready: true});
    };
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!panel.current?.contains(target) && !anchor.current?.contains(target)) close.current();
    };
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); close.current(); anchor.current?.focus(); }
    };
    const focus = (event: FocusEvent) => {
      const target = event.target as Node;
      if (!panel.current?.contains(target) && !anchor.current?.contains(target)) close.current();
    };
    update();
    panel.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({preventScroll: true});
    const observer = new ResizeObserver(update);
    if (panel.current) observer.observe(panel.current);
    if (anchor.current) observer.observe(anchor.current);
    window.addEventListener("resize", update);
    document.addEventListener("scroll", update, true);
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", keyboard);
    document.addEventListener("focusin", focus);
    return () => { observer.disconnect(); window.removeEventListener("resize", update);
      document.removeEventListener("scroll", update, true); document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", keyboard); document.removeEventListener("focusin", focus); };
  }, [anchor]);
  return createPortal(<section ref={panel} className="permission-popover" role="dialog" aria-label="会话权限"
    style={{left: position.left, top: position.top, maxHeight: position.maxHeight, visibility: position.ready ? "visible" : "hidden"}}>
    <header><strong>会话权限</strong><small>自动保存</small><button type="button" className="permission-close" aria-label="关闭会话权限" onClick={() => {onClose(); anchor.current?.focus();}}>
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>
    </button></header>
    {error && <p className="form-error" role="alert">{error}</p>}
    {fields.map(field => <div className={`permission-row ${field.key === "blockUnreferencedAssets" ? "permission-scope" : ""}`} key={field.key}>
      <span className="permission-label" title={field.description}>{field.label}</span>
      <button type="button" className="permission-switch" role="switch" aria-label={field.label} aria-description={field.description} title={field.description} aria-checked={Boolean(options[field.key] ?? permissionDefaults[field.key])} disabled={disabled} onClick={() => onChange(field.key, !Boolean(options[field.key] ?? permissionDefaults[field.key]))}><span/></button>
    </div>)}
    {disabled && <p className="permission-note">本轮结束或停止后可修改</p>}
  </section>, document.body);
}
