import { useEffect, useRef, useState, type ReactNode } from "react";

export function TerminalSidePanel({ open, onClose, onOpen, children }: { open: boolean; onClose: () => void; onOpen?: () => void; children: ReactNode }) {
  const [mounted, setMounted] = useState(open);
  const [visible, setVisible] = useState(open);
  const onOpenRef = useRef(onOpen);
  onOpenRef.current = onOpen;
  useEffect(() => {
    if (open) { setMounted(true); const frame = requestAnimationFrame(() => setVisible(true)); return () => cancelAnimationFrame(frame); }
    setVisible(false);
    // Keep visited terminal screens alive while the panel is collapsed.
  }, [open]);
  useEffect(() => {
    if (!open || !mounted || !visible) return;
    const frame = requestAnimationFrame(() => onOpenRef.current?.());
    return () => cancelAnimationFrame(frame);
  }, [open, mounted, visible]);
  return <>
    {open && <button type="button" className="terminal-panel-scrim" aria-label="收起终端面板" onClick={onClose}/>}
    <div className="terminal-side-slot" inert={!open} aria-hidden={!open}>
      {mounted && <aside className={`terminal-side-panel ${open && visible ? "is-open" : ""}`} aria-label="资源终端" onKeyDown={event => {
        if (event.key === "Escape" && !(event.target as HTMLElement).closest(".terminal-screen")) { event.preventDefault(); onClose(); }
      }}>{children}</aside>}
    </div>
  </>;
}
