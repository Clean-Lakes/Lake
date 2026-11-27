import { useId, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Glyph } from "./Icons";
import {DisclosureSummary} from "./DisclosureSummary";
import { useMenuMotion } from "./useMenuMotion";

import {permissionDefaults} from '../../shared/execution-preferences';
export {permissionDefaults} from '../../shared/execution-preferences';

const groups: Array<{title: string; showTitle?: boolean; fields: Array<{key: keyof typeof permissionDefaults; label: string; description: string}>}> = [
  {title: "免确认操作", fields: [
    {key: "silentReadFiles", label: "读取文件", description: "浏览、搜索和读取文件、技能及网页内容。"},
    {key: "silentWriteFiles", label: "写入文件", description: "上传和编辑文件；删除、移动按命令规则。"},
    {key: "silentReadSQL", label: "查询数据库", description: "执行只读 SQL，查看表结构。"},
    {key: "silentMCPCalls", label: "调用 MCP 工具", description: "自动调用项目已启用的 MCP 工具，包括可能修改外部系统的工具。"},
    {key: "silentCommands", label: "运行命令", description: "自动执行脚本和系统命令，包括修改、删除和移动；关闭后逐次确认。"},
    {key: "silentTerminalCreation", label: "建立终端连接", description: "新建或重连终端；首次 SSH 指纹仍需核对。"},
  ]},
  {title: "操作范围", showTitle: true, fields: [
    {key: "blockUnreferencedAssets", label: "仅限引用资源", description: "只操作本轮 @ 选择或上下文引用的资源。"},
    {key: "denyLocalExecution", label: "禁用本机执行", description: "限制本机命令和终端，不影响 SSH 主机。"},
  ]},
];

export function PermissionSettings({anchor, options, open=true, disabled, saving=false, error, onChange, onClose}: {
  anchor: RefObject<HTMLButtonElement | null>;
  options: Record<string, unknown>; open?: boolean; disabled: boolean; saving?: boolean; error?: string;
  onChange: (key: string, value: boolean) => void; onClose: () => void;
}) {
  const panel = useRef<HTMLElement>(null);
  const id = useId();
  const close = useRef(onClose);
  close.current = onClose;
  const [position, setPosition] = useState<{left: number; top?: number; bottom?: number; maxHeight: number}>();
  useLayoutEffect(() => {
    if (!open) return;
    const trigger = anchor.current;
    const content = panel.current;
    if (!trigger || !content) return;

    const composer = trigger.closest(".composer-input");
    const gap = 10;
    const edge = 12;
    const minimumRoom = 160;
    const update = () => {
      const rect = trigger.getBoundingClientRect();
      const composerTop = composer?.getBoundingClientRect().top ?? rect.top;
      const titlebarHeight = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--lake-titlebar-height")) || 0;
      const topEdge = Math.max(edge, titlebarHeight);
      const below = window.innerHeight - rect.bottom - gap - edge;
      // In short windows, the space above the button can still fit a scrollable panel.
      const aboveAnchor = composerTop - gap - topEdge < minimumRoom && below < minimumRoom ? rect.top : composerTop;
      const above = aboveAnchor - gap - topEdge;
      const upward = above >= below;
      const left = Math.max(edge, Math.min(rect.left - 8, window.innerWidth - content.offsetWidth - edge));
      const top = upward ? undefined : rect.bottom + gap;
      const bottom = upward ? window.innerHeight - aboveAnchor + gap : undefined;
      const maxHeight = Math.max(0, Math.min(420, upward ? above : below));
      setPosition(current => current?.left === left && current.top === top && current.bottom === bottom && current.maxHeight === maxHeight
        ? current
        : {left, top, bottom, maxHeight});
    };
    const dismissOutside = (event: Event) => {
      const target = event.target as Node;
      if (!content.contains(target) && !trigger.contains(target)) close.current();
    };
    const keyboard = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      close.current();
      trigger.focus({preventScroll: true});
    };
    update();
    const focusFrame = requestAnimationFrame(() => content.querySelector<HTMLButtonElement>(".permission-close")?.focus({preventScroll: true}));
    const observer = new ResizeObserver(update);
    observer.observe(trigger);
    if (composer) observer.observe(composer);
    window.addEventListener("resize", update);
    window.addEventListener("lake-chrome-resize", update);
    document.addEventListener("scroll", update, true);
    document.addEventListener("pointerdown", dismissOutside);
    document.addEventListener("keydown", keyboard);
    document.addEventListener("focusin", dismissOutside);
    return () => {
      cancelAnimationFrame(focusFrame);
      observer.disconnect();
      window.removeEventListener("resize", update);
      window.removeEventListener("lake-chrome-resize", update);
      document.removeEventListener("scroll", update, true);
      document.removeEventListener("pointerdown", dismissOutside);
      document.removeEventListener("keydown", keyboard);
      document.removeEventListener("focusin", dismissOutside);
    };
  }, [anchor, open]);
  const retain = useMenuMotion(panel, open && Boolean(position), true);
  if (!open && !retain) return null;

  return createPortal(
    <section ref={panel} className="permission-popover" role="dialog" aria-labelledby={`${id}-title`}
      data-menu-motion="true" inert={!open} aria-hidden={!open || undefined}
      style={position ? {...position, transformOrigin: position.bottom !== undefined ? "left bottom" : "left top"} : {visibility: "hidden"}}>
      <header className="permission-header">
        <strong id={`${id}-title`}>执行偏好</strong>
        <span className="permission-save-state" role="status">{saving && "正在保存…"}</span>
        <button type="button" className="permission-close" aria-label="关闭执行偏好" onClick={() => {
          onClose();
          anchor.current?.focus({preventScroll: true});
        }}><Glyph name="close" size={14}/></button>
      </header>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div aria-busy={saving}>
        {groups.map(group => <div className="permission-group" role="group" aria-label={group.title} key={group.title}>
          {group.showTitle && <div className="permission-group-heading">{group.title}</div>}
          {group.fields.map(field => {
            const checked = Boolean(options[field.key] ?? permissionDefaults[field.key]);
            return <div className="permission-row" key={field.key}>
              <span id={`${id}-${field.key}`}>{field.label}</span>
              <button type="button" className="permission-toggle" role="switch" aria-labelledby={`${id}-${field.key}`}
                aria-describedby={`${id}-${field.key}-description`} aria-checked={checked} disabled={disabled}
                aria-disabled={disabled || saving} onClick={() => {
                  if (!saving && !disabled) onChange(field.key, !checked);
                }}><span className="permission-toggle-track" aria-hidden="true"/></button>
            </div>;
          })}
        </div>)}
      </div>
      {disabled && <p className="permission-note permission-locked" role="status">本轮结束或停止后可调整</p>}
      <details className="permission-help">
        <DisclosureSummary>操作说明</DisclosureSummary>
        <dl>{groups.flatMap(group => group.fields).map(field => <div key={field.key}>
          <dt>{field.label}</dt>
          <dd id={`${id}-${field.key}-description`}>{field.description}</dd>
        </div>)}</dl>
        <p className="permission-note">允许免确认运行命令时，也会按需建立终端连接。</p>
      </details>
    </section>,
    document.body,
  );
}
