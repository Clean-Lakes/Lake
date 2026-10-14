import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import type { Message } from "../../shared/contracts";

export type ConversationDirectoryItem = { id: string; number: number; label: string };
export function conversationDirectoryItems(messages: Message[], visibleIds: Set<string>): ConversationDirectoryItem[] {
  return messages.filter(message => message.role === "user").map((message, index) => ({
    id: message.id, number: index + 1, label: message.text.replace(/\s+/g, " ").trim() || "图片或附件",
  })).filter(item => visibleIds.has(item.id));
}
export function conversationTurnId(sessionId: string, entryId: string) {
  return `conversation-turn-${encodeURIComponent(sessionId)}-${encodeURIComponent(entryId)}`;
}

export function activeDirectoryItem(positions: {id: string; top: number}[], viewportTop: number) {
  return positions.filter(item => item.top <= viewportTop + 32).at(-1)?.id ?? positions[0]?.id ?? null;
}

export function ConversationDirectory({sessionId, items, onJump, onLatest, onOpen, onLoadOlder, loading = false}: {
  sessionId: string;
  items: ConversationDirectoryItem[]; onJump: (id: string) => void; onLatest: () => void;
  onOpen?: () => void; onLoadOlder?: () => void; loading?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string | null>(items[0]?.id ?? null);
  const [panelHeight, setPanelHeight] = useState(320);
  const [panelWidth, setPanelWidth] = useState(270);
  const root = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const itemIds = JSON.stringify(items.map(item => item.id));
  const railHeight = Math.max(28, Math.min(128, items.length * 7 + 12));
  function close() { setOpen(false); trigger.current?.focus({preventScroll:true}); }
  useLayoutEffect(() => {
    const container = root.current?.closest<HTMLElement>(".conversation");
    if (!container) return;
    let frame = 0;
    function update() {
      const positions = items.flatMap(item => {
        const turn = document.getElementById(conversationTurnId(sessionId, item.id));
        return turn ? [{id: item.id, top: turn.getBoundingClientRect().top}] : [];
      });
      setSelected(activeDirectoryItem(positions, container!.getBoundingClientRect().top));
    }
    function schedule() {cancelAnimationFrame(frame);frame=requestAnimationFrame(update);}
    update();
    const observer = new ResizeObserver(schedule);
    observer.observe(container);
    const content = container.querySelector(".timeline-list");
    if(content)observer.observe(content);
    container.addEventListener("scroll",schedule);
    return()=>{cancelAnimationFrame(frame);observer.disconnect();container.removeEventListener("scroll",schedule);};
  }, [sessionId, itemIds]);
  useLayoutEffect(() => {
    if (!open) return;
    const container = root.current?.closest<HTMLElement>(".conversation");
    if (!container) return;
    function measure() {
      const bottom = container!.getBoundingClientRect().bottom;
      const top = trigger.current?.getBoundingClientRect().top ?? bottom;
      setPanelHeight(Math.max(80, Math.min(420, bottom - top - 10)));
      const left = panel.current?.getBoundingClientRect().left ?? container!.getBoundingClientRect().left;
      setPanelWidth(Math.max(120, Math.min(270, container!.getBoundingClientRect().right - left - 10)));
    }
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    container.addEventListener("scroll", measure);
    return () => {observer.disconnect();container.removeEventListener("scroll", measure);};
  }, [open]);
  useLayoutEffect(() => {
    if (!open) return;
    const current = panel.current?.querySelector<HTMLElement>("[aria-current='location']");
    const list = current?.parentElement;
    if(!current || !list)return;
    const itemBox=current.getBoundingClientRect(), listBox=list.getBoundingClientRect();
    if(itemBox.top<listBox.top)list.scrollTop+=itemBox.top-listBox.top;
    else if(itemBox.bottom>listBox.bottom)list.scrollTop+=itemBox.bottom-listBox.bottom;
  }, [open, selected, panelHeight]);
  useEffect(() => {
    if (!open) return;
    function outside(event: PointerEvent) { if (!root.current?.contains(event.target as Node)) setOpen(false); }
    function escape(event: KeyboardEvent) { if (event.key === "Escape") { event.preventDefault(); close(); } }
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); };
  }, [open]);
  return <div className="conversation-directory" ref={root} style={{"--directory-rail-height":`${railHeight}px`,"--directory-count":Math.max(1,items.length)} as CSSProperties}>
    <button type="button" ref={trigger} className="conversation-directory-trigger" aria-label="会话目录" title="会话目录" aria-expanded={open} aria-controls={panelId} aria-haspopup="dialog" onClick={() => { if(!open)onOpen?.(); setOpen(!open); }}>
      <span className="conversation-directory-marks" aria-hidden="true">{items.map(item=><span key={item.id} data-directory-item={item.id} className={`conversation-directory-mark${selected===item.id?" is-current":""}`}/>)}</span>
    </button>
    {open && <div ref={panel} className="conversation-directory-panel" style={{maxHeight:panelHeight,width:panelWidth}} id={panelId} role="dialog" aria-label="会话目录">
      <header><strong>会话目录</strong><span>{items.length} 轮</span></header>
      <nav aria-label="跳转到提问">{items.map(item => <button type="button" key={item.id} aria-label={`跳转到第 ${item.number} 轮：${item.label}`} aria-current={selected===item.id?"location":undefined} title={item.label} onClick={() => { onJump(item.id); setSelected(item.id); close(); }}><span className={`conversation-directory-row-mark${selected===item.id?" is-current":""}`} aria-hidden="true"/><span>{item.label}</span></button>)}{!items.length&&<p>暂无提问</p>}</nav>
      {onLoadOlder&&<button type="button" className="conversation-directory-older" disabled={loading} onClick={onLoadOlder}>{loading?"正在加载…":"加载更早记录"}</button>}
      <button type="button" className="conversation-directory-latest" onClick={() => {onLatest();close();}}>跳到最新</button>
    </div>}
  </div>;
}
