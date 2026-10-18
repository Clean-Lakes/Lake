import { useId, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Glyph } from "./Icons";

export const permissionDefaults = {
  silentReadFiles: true,
  silentWriteFiles: false,
  silentReadSQL: true,
  silentCommands: true,
  silentTerminalCreation: true,
  blockUnreferencedAssets: false,
  denyLocalExecution: false,
};

const groups: Array<{title: string; hint?: string; fields: Array<{key: keyof typeof permissionDefaults; label: string; description: string}>}> = [
  {title: "免确认操作", hint: "关闭后先询问", fields: [
    {key: "silentReadFiles", label: "读取文件", description: "浏览目录、搜索和查看文件内容。"},
    {key: "silentWriteFiles", label: "写入文件", description: "上传和编辑文件；删除、移动按命令规则。"},
    {key: "silentReadSQL", label: "查询数据库", description: "执行只读 SQL，查看表结构。"},
    {key: "silentCommands", label: "运行命令", description: "包括修改、指定文件的删除和移动；大范围删除等仍需确认。"},
    {key: "silentTerminalCreation", label: "建立终端连接", description: "新建或重连终端；首次 SSH 指纹仍需核对。"},
  ]},
  {title: "操作范围", fields: [
    {key: "blockUnreferencedAssets", label: "仅限引用资源", description: "只操作本轮 @ 选择或上下文引用的资源。"},
    {key: "denyLocalExecution", label: "禁用本机执行", description: "限制本机命令和终端，不影响 SSH 主机。"},
  ]},
];

export function PermissionSettings({anchor, options, disabled, error, onChange, onClose}: {
  anchor: RefObject<HTMLButtonElement | null>;
  options: Record<string, unknown>; disabled: boolean; error?: string;
  onChange: (key: string, value: boolean) => void; onClose: () => void;
}) {
  const panel = useRef<HTMLElement>(null);
  const id = useId();
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
    const focusFrame = requestAnimationFrame(() => panel.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({preventScroll: true}));
    const observer = new ResizeObserver(update);
    if (panel.current) observer.observe(panel.current);
    if (anchor.current) observer.observe(anchor.current);
    window.addEventListener("resize", update);
    document.addEventListener("scroll", update, true);
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", keyboard);
    document.addEventListener("focusin", focus);
    return () => { cancelAnimationFrame(focusFrame); observer.disconnect(); window.removeEventListener("resize", update);
      document.removeEventListener("scroll", update, true); document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", keyboard); document.removeEventListener("focusin", focus); };
  }, [anchor]);
  return createPortal(<section ref={panel} className="permission-popover" role="dialog" aria-label="会话权限"
    style={{left: position.left, top: position.top, maxHeight: position.maxHeight, visibility: position.ready ? "visible" : "hidden"}}>
    <header><div><strong>执行偏好</strong><p>当前会话 · 自动保存</p></div><button type="button" className="permission-close" aria-label="关闭会话权限" onClick={() => {onClose(); anchor.current?.focus();}}><Glyph name="close" size={14}/></button></header>
    {error && <p className="form-error" role="alert">{error}</p>}
    {groups.map((group, index) => <div className="permission-group" role="group" aria-labelledby={`${id}-group-${index}`} key={group.title}>
      <div className="permission-group-heading"><span id={`${id}-group-${index}`}>{group.title}</span>{group.hint && <small>{group.hint}</small>}</div>
      {group.fields.map(field => {
        const checked = Boolean(options[field.key] ?? permissionDefaults[field.key]);
        return <div className="permission-row" key={field.key}>
          <div className="permission-copy"><span className="permission-label" id={`${id}-${field.key}`}>{field.label}</span><p id={`${id}-${field.key}-description`}>{field.description}</p></div>
          <button type="button" className="permission-mode" role="switch" aria-labelledby={`${id}-${field.key}`} aria-describedby={`${id}-${field.key}-description`} aria-checked={checked} disabled={disabled} onClick={() => onChange(field.key, !checked)}>{checked ? "开启" : "关闭"}</button>
        </div>;
      })}
    </div>)}
    <p className="permission-note">允许免确认运行命令时，也会按需建立终端连接。</p>
    {disabled && <p className="permission-note permission-locked" role="status">本轮结束或停止后可调整</p>}

  </section>, document.body);
}
