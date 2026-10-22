import {useEffect, useMemo, useRef, useState} from "react";
import type {Project, Resource, WorkSession} from "../../shared/contracts";
import {Glyph, ResourceIcon} from "./Icons";
import "./workspaceSearch.css";

type SearchEntry = {kind: "session" | "resource"; id: string; projectId: string; label: string; projectName: string; icon: string};
type Props = {
  projects: Project[];
  sessions: WorkSession[];
  resources: Resource[];
  canCreate: boolean;
  onChoose: (entry: SearchEntry) => void;
  onNewSession: () => void;
  onClose: () => void;
};

export function WorkspaceSearch({projects, sessions, resources, canCreate, onChoose, onNewSession, onClose}: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const {chats, assets} = useMemo(() => {
    const names = new Map(projects.map(project => [project.id, project.name]));
    const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    const matches = (label: string, projectId: string) => names.has(projectId) && words.every(word => `${label} ${names.get(projectId)}`.toLocaleLowerCase().includes(word));
    return {
      chats: sessions.filter(session => matches(session.title, session.projectId)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, words.length ? 30 : 9).map(session => ({kind: "session" as const, id: session.id, projectId: session.projectId, label: session.title, projectName: names.get(session.projectId)!, icon: session.icon ?? "chat"})),
      assets: words.length ? resources.filter(resource => matches(resource.name, resource.projectId)).sort((a, b) => a.name.localeCompare(b.name)).slice(0, 20).map(resource => ({kind: "resource" as const, id: resource.id, projectId: resource.projectId, label: resource.name, projectName: names.get(resource.projectId)!, icon: resource.kind})) : [],
    };
  }, [projects, sessions, resources, query]);
  const entries = [...chats, ...assets];
  const count = entries.length + (canCreate ? 1 : 0);
  const selected = active < 0 ? entries.length ? 0 : -1 : count ? Math.min(active, count - 1) : -1;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const node = dialog.current;
    node?.showModal();
    input.current?.focus({preventScroll: true});
    return () => {
      node?.close();
      if (previous?.isConnected && document.activeElement === document.body) previous.focus({preventScroll: true});
    };
  }, []);
  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({block: "nearest"});
  }, [selected, query]);
  const dismiss = () => { dialog.current?.close(); onClose(); };
  const choose = (index: number) => {
    const entry = entries[index];
    if (entry) { dismiss(); onChoose(entry); }
    else if (index === entries.length && canCreate) { dismiss(); onNewSession(); }
  };
  const row = (entry: SearchEntry, index: number) => <button key={`${entry.kind}-${entry.id}`} id={`workspace-search-option-${index}`} role="option" aria-selected={selected === index} type="button" tabIndex={-1} className="workspace-search-row" onPointerMove={() => setActive(index)} onClick={() => choose(index)}>
    {entry.kind === "resource" ? <ResourceIcon kind={entry.icon} size={17}/> : <Glyph name={entry.icon} size={17}/>}
    <span className="workspace-search-label">{entry.label}</span><span className="workspace-search-project">{entry.projectName}</span>
    {selected === index && <kbd>↵</kbd>}
  </button>;
  return <dialog ref={dialog} id="workspace-search-dialog" className="workspace-search-dialog" aria-label="搜索会话和资源" onCancel={event => {event.preventDefault(); dismiss();}} onClick={event => {
    if (event.target !== event.currentTarget) return;
    const rect = event.currentTarget.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dismiss();
  }} onKeyDown={event => {
    if (event.nativeEvent.isComposing) return;
    const command = /Mac/.test(navigator.platform) ? event.metaKey : event.ctrlKey;
    if (command && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "k") {
      event.preventDefault(); event.stopPropagation(); input.current?.focus(); input.current?.select();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setActive(count ? event.key === "ArrowDown" ? (selected + 1 + count) % count : selected <= 0 ? count - 1 : selected - 1 : -1);
    } else if (event.key === "Enter" && event.target === input.current) {
      event.preventDefault();
      if (selected >= 0) choose(selected);
    } else if (command && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "n" && canCreate) {
      event.preventDefault(); event.stopPropagation(); dismiss(); onNewSession();
    }
  }}>
    <div className="workspace-search-input-row"><Glyph name="search" size={19}/><input ref={input} type="search" role="combobox" aria-label="搜索会话或资源" aria-autocomplete="list" aria-expanded="true" aria-controls="workspace-search-results" aria-activedescendant={selected >= 0 ? `workspace-search-option-${selected}` : undefined} placeholder="搜索会话或资源…" value={query} onChange={event => {setQuery(event.target.value); setActive(-1);}}/><button type="button" className="icon-button" aria-label="关闭搜索" onClick={dismiss}><Glyph name="close" size={16}/></button></div>
    <div ref={list} id="workspace-search-results" className="workspace-search-results" role="listbox" aria-label="搜索结果">
      {!!chats.length && <div role="group" aria-labelledby="workspace-search-chats"><div className="workspace-search-group" id="workspace-search-chats">{query.trim() ? "会话" : "最近会话"}</div>{chats.map((entry, index) => row(entry, index))}</div>}
      {!!assets.length && <div role="group" aria-labelledby="workspace-search-assets"><div className="workspace-search-group" id="workspace-search-assets">资源</div>{assets.map((entry, index) => row(entry, chats.length + index))}</div>}
      {!entries.length && <p className="workspace-search-empty" role="status">{query.trim() ? "没有找到匹配的会话或资源" : "还没有会话"}</p>}
      {canCreate && <div role="group" aria-labelledby="workspace-search-actions"><div className="workspace-search-group" id="workspace-search-actions">快捷操作</div><button type="button" role="option" id={`workspace-search-option-${entries.length}`} aria-selected={selected === entries.length} tabIndex={-1} className="workspace-search-row" onPointerMove={() => setActive(entries.length)} onClick={() => choose(entries.length)}><Glyph name="edit" size={17}/><span className="workspace-search-label">新对话</span><kbd>{/Mac/.test(navigator.platform) ? "⌘N" : "Ctrl N"}</kbd></button></div>}
    </div>
  </dialog>;
}
