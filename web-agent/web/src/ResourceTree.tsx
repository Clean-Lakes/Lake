import { useEffect, useRef, useState, type DragEvent, type PointerEvent, type ReactNode } from "react";
import type { Project, Resource, ResourceTreeNode } from "../../shared/contracts";
import { api, readableError } from "./api";
import { canMoveInto, dropPlacement, projectResourceTree } from "./resource-tree-model";

function FolderIcon() { return <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/></svg>; }
export function ResourceTree({project, resources, nodes, disabled, renderResource, refresh, onAddResource, onImport}: {
  project: Project; resources: Resource[]; nodes: ResourceTreeNode[]; disabled: boolean;
  renderResource: (resource: Resource) => ReactNode; refresh: () => Promise<unknown>; onAddResource: () => void; onImport: () => void;
}) {
  const tree = projectResourceTree(project.id, nodes, resources);
  const resourceMap = new Map(resources.map(resource => [resource.id, resource]));
  const nodeMap = new Map(tree.map(node => [node.id, node]));
  const children = new Map<string | null, ResourceTreeNode[]>();
  for (const node of tree) { const siblings = children.get(node.parentId) ?? []; siblings.push(node); children.set(node.parentId,siblings); }
  for (const siblings of children.values()) siblings.sort((a,b)=>a.position-b.position || a.id.localeCompare(b.id));
  const childrenOf = (parent: string | null) => children.get(parent) ?? [];
  const [closed, setClosed] = useState<string[]>(() => {
    try { const saved: unknown = JSON.parse(localStorage.getItem(`lake.resource-folders.${project.id}`) || "[]"); return Array.isArray(saved) ? saved.filter(id => typeof id === "string") : []; } catch { return []; }
  });
  useEffect(() => {try {localStorage.setItem(`lake.resource-folders.${project.id}`, JSON.stringify(closed));} catch {}}, [project.id, closed]);
  const [editor, setEditor] = useState<{id?: string; parentId: string | null; name: string} | null>(null);
  const [moving, setMoving] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const dragSource = useRef<string | null>(null);
  const pointerDrag = useRef<{source:string; pointer:number; x:number; y:number; active:boolean} | null>(null);
  const pointerDrop = useRef<{parentId:string|null; beforeId:string|null} | null>(null);
  const suppressClick = useRef(false);
  const [drop, setDrop] = useState<{id: string; zone: "before" | "inside" | "after"} | null>(null);
  const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const blocked = disabled || busy;
  const [addOpen, setAddOpen] = useState(false);
  const addControl = useRef<HTMLDivElement>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const addMenu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!addOpen) return;
    if (blocked) { setAddOpen(false); return; }
    addMenu.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const dismiss = (event: globalThis.PointerEvent) => { if (!addControl.current?.contains(event.target as Node)) setAddOpen(false); };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [addOpen, blocked]);
  const work = async (data: Parameters<typeof api.editResourceTree>[1]) => {
    if (blocked) return;
    setBusy(true); setError("");
    try { await api.editResourceTree(project.id, data); await refresh(); setEditor(null); setMoving(null); }
    catch (error) { setError(readableError(error)); }
    finally {setBusy(false); dragSource.current = null; setDragging(null); setDrop(null);}
  };
  const move = (source: string, parentId: string | null, beforeId: string | null = null) => {
    if (source === beforeId || !canMoveInto(tree, source, parentId)) return;
    if (parentId) setClosed(values => values.filter(id => id !== parentId));
    void work({operation:"move", nodeId:source, parentId, beforeId});
  };
  // Pointer capture works for mouse, trackpad and touch, including browsers
  // whose embedded web view does not provide native HTML drag sessions.
  const pointerMove = (event: PointerEvent<HTMLButtonElement>) => {
    const drag = pointerDrag.current;
    if (!drag || drag.pointer !== event.pointerId || blocked) return;
    if (!drag.active && Math.hypot(event.clientX-drag.x,event.clientY-drag.y) < 5) return;
    if (!drag.active) {drag.active=true;dragSource.current=drag.source;setDragging(drag.source);}
    const target = document.elementFromPoint(event.clientX,event.clientY);
    const inside = target?.closest<HTMLElement>("[data-resource-drop-inside]");
    const row = target?.closest<HTMLElement>("[data-resource-tree-node]");
    let place: {parentId:string|null;beforeId:string|null} | null = null;
    let marker: typeof drop = null;
    if (inside && canMoveInto(tree,drag.source,inside.dataset.resourceDropInside || null)) {
      place={parentId:inside.dataset.resourceDropInside || null,beforeId:null};
      marker={id:inside.dataset.resourceDropInside || "root",zone:"inside"};
    } else if(row) {
      const node=tree.find(node=>node.id===row.dataset.resourceTreeNode);
      if(node && node.id!==drag.source) {
        const bounds=row.getBoundingClientRect();const ratio=(event.clientY-bounds.top)/Math.max(1,bounds.height);
        const zone=node.kind==="resource" ? (ratio<.5 ? "before":"after") : ratio<.25 ? "before":ratio>.75 ? "after":"inside";
        const candidate=dropPlacement(tree,node,zone);
        if(canMoveInto(tree,drag.source,candidate.parentId)){place=candidate;marker={id:node.id,zone};}
      }
    }
    pointerDrop.current=place;
    setDrop(current=>current?.id===marker?.id && current?.zone===marker?.zone ? current:marker);
  };
  const pointerEnd = (event: PointerEvent<HTMLButtonElement>, cancelled = false) => {
    const drag=pointerDrag.current;
    if(!drag || drag.pointer!==event.pointerId)return;
    pointerDrag.current=null;
    if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);
    const place=pointerDrop.current;pointerDrop.current=null;
    if(drag.active){suppressClick.current=true;setTimeout(()=>{suppressClick.current=false;},0);if(!cancelled && place)move(drag.source,place.parentId,place.beforeId);}
    dragSource.current=null;setDragging(null);setDrop(null);
  };
  const dragOver = (event: DragEvent<HTMLElement>, node: ResourceTreeNode) => {
    const source = dragSource.current;
    if (!source || blocked || source === node.id) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const ratio = (event.clientY - bounds.top) / Math.max(1, bounds.height);
    const zone = node.kind === "resource" ? (ratio < .5 ? "before" : "after") : ratio < .25 ? "before" : ratio > .75 ? "after" : "inside";
    const placement = dropPlacement(tree, node, zone);
    if (!canMoveInto(tree, source, placement.parentId)) return;
    event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = "move";
    setDrop(current => current?.id === node.id && current.zone === zone ? current : {id:node.id,zone});
  };
  const render = (parent: string | null, depth = 0): ReactNode => childrenOf(parent).map(node => {
    const resource = node.resourceId ? resourceMap.get(node.resourceId) : undefined;
    const expanded = !closed.includes(node.id);
    const siblings = childrenOf(parent); const index = siblings.findIndex(item => item.id === node.id);
    return <div className={`resource-tree-node ${dragging === node.id ? "is-dragging" : ""}`} key={node.id}>
      <div data-resource-tree-node={node.id} className={`resource-tree-row ${drop?.id === node.id ? `drop-${drop.zone}` : ""}`} onDragOver={event => dragOver(event,node)} onDrop={event => {
        event.preventDefault(); event.stopPropagation();
        const source = dragSource.current || event.dataTransfer.getData("application/x-lake-resource-tree");
        if (!source || source === node.id || blocked) return;
        const bounds = event.currentTarget.getBoundingClientRect();
        const ratio = (event.clientY - bounds.top) / Math.max(1,bounds.height);
        const zone = node.kind === "resource" ? (ratio < .5 ? "before" : "after") : ratio < .25 ? "before" : ratio > .75 ? "after" : "inside";
        const target = dropPlacement(tree,node,zone); move(source,target.parentId,target.beforeId);
      }}>
        <button type="button" className="resource-drag-handle" aria-label={`拖动或移动 ${resource?.name || node.name}`} title="拖动排序或移动到目录；点击选择位置" disabled={blocked} draggable={false}
          onClick={() => {if(!suppressClick.current)setMoving(current => current === node.id ? null : node.id);}}
          onPointerDown={event=>{if(blocked || event.button!==0)return;event.preventDefault();event.currentTarget.setPointerCapture(event.pointerId);pointerDrag.current={source:node.id,pointer:event.pointerId,x:event.clientX,y:event.clientY,active:false};pointerDrop.current=null;}}
          onPointerMove={pointerMove} onPointerUp={event=>pointerEnd(event)} onPointerCancel={event=>pointerEnd(event,true)}
          onDragStart={event => {dragSource.current = node.id;event.dataTransfer.setData("application/x-lake-resource-tree",node.id);event.dataTransfer.effectAllowed="move";setDragging(node.id);setError("");}} onDragEnd={() => {dragSource.current = null;setDragging(null);setDrop(null);}}>⠿</button>
        {node.kind === "folder" ? <div className="resource-folder-row">
          <button type="button" className="resource-folder-toggle" aria-expanded={expanded} onClick={() => setClosed(values => expanded ? [...values,node.id] : values.filter(id => id !== node.id))}><span className={expanded ? "folder-chevron open" : "folder-chevron"}>›</span><FolderIcon/><span>{node.name}</span></button>
          <div className="resource-folder-actions"><button type="button" disabled={blocked} aria-label={`在 ${node.name} 新建子目录`} title="新建子目录" onClick={() => {setEditor({parentId:node.id,name:""});setClosed(values => values.filter(id => id !== node.id));}}>+</button><button type="button" disabled={blocked} aria-label={`管理目录 ${node.name}`} title="重命名或移除目录" onClick={() => setEditor({id:node.id,parentId:node.parentId,name:node.name})}>⋯</button></div>
        </div> : resource && renderResource(resource)}
      </div>
      {moving === node.id && <div className="resource-move-panel" role="group" aria-label={`移动 ${resource?.name || node.name}`}>
        <div><button disabled={blocked || index === 0} onClick={() => move(node.id,parent,siblings[index-1]?.id ?? null)}>上移</button><button disabled={blocked || index === siblings.length-1} onClick={() => move(node.id,parent,siblings[index+2]?.id ?? null)}>下移</button></div>
        <label>移到目录<select aria-label={`将 ${resource?.name || node.name} 移到目录`} value="" disabled={blocked} onChange={event => {if(event.target.value) move(node.id,event.target.value === "root" ? null : event.target.value);}}><option value="">选择位置…</option><option value="root">资源根层</option>{tree.filter(folder => folder.kind === "folder" && canMoveInto(tree,node.id,folder.id)).map(folder => <option value={folder.id} key={folder.id}>{folderPath(folder)}</option>)}</select></label>
      </div>}
      {node.kind === "folder" && expanded && depth < 32 && <div className="resource-folder-children">{render(node.id,depth+1)}{!childrenOf(node.id).length && <div data-resource-drop-inside={node.id} className={`resource-folder-empty ${drop?.id === node.id ? "drop-inside" : ""}`} onDragOver={event => {if(dragSource.current && canMoveInto(tree,dragSource.current,node.id)){event.preventDefault();event.stopPropagation();setDrop({id:node.id,zone:"inside"});}}} onDrop={event => {event.preventDefault();event.stopPropagation();if(dragSource.current)move(dragSource.current,node.id);}}>拖动资源到这里</div>}</div>}
    </div>;
  });
  function folderPath(folder: ResourceTreeNode) {
    const names=[folder.name];let parent=folder.parentId;const seen=new Set([folder.id]);
    while(parent && !seen.has(parent)){seen.add(parent);const node=nodeMap.get(parent);if(!node)break;names.unshift(node.name);parent=node.parentId;}
    return names.join(" / ");
  }
  return <><div className="nav-heading resources-heading"><span>资源 <small>{resources.length}</small></span><div className="resource-add-control" ref={addControl} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setAddOpen(false); }}>
    <button type="button" ref={addButton} className="nav-add resource-create-trigger" aria-label={`在${project.name}新建资源或目录`} title="新建资源或目录" aria-haspopup="menu" aria-expanded={addOpen} aria-controls={`resource-add-${project.id}`} disabled={blocked} onClick={() => setAddOpen(value => !value)}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg><span>新建</span></button>
    {addOpen && <div ref={addMenu} id={`resource-add-${project.id}`} className="resource-add-menu" role="menu" aria-label="新建资源或目录" onMouseDown={event => {
      // Safari 点击按钮时会先 blur 到 body；保留菜单焦点，避免 onBlur 在 click 前卸载菜单。
      if (event.button === 0) event.preventDefault();
    }} onKeyDown={event => {
      if (event.key === "Escape") { event.preventDefault(); setAddOpen(false); addButton.current?.focus(); }
      if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        event.preventDefault(); const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button")); const index = items.indexOf(document.activeElement as HTMLButtonElement);
        items[event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (index + (event.key === "ArrowUp" ? -1 : 1) + items.length) % items.length]?.focus();
      }
    }}>
      <button type="button" role="menuitem" onClick={() => { setAddOpen(false); onAddResource(); }}><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><rect x="3" y="3" width="18" height="7" rx="1.5"/><rect x="3" y="14" width="18" height="7" rx="1.5"/><path d="M7 6.5h.01M7 17.5h.01M11 6.5h7M11 17.5h7"/></svg><span>新建资源<small>SSH、数据库、Redis、Docker</small></span></button>
      <button type="button" role="menuitem" onClick={() => { setAddOpen(false); onImport(); }}><FolderIcon/><span>从文本导入<small>文件、JSON、CSV、连接说明</small></span></button>
      <button type="button" role="menuitem" onClick={() => { setAddOpen(false); setEditor({parentId:null,name:""}); }}><FolderIcon/>新建目录</button>
    </div>}
  </div></div><div className="resource-tree" aria-label={`${project.name} 资源目录`}>
    {editor && <form className="resource-folder-editor" onSubmit={event => {event.preventDefault();void work({operation:editor.id ? "rename":"create",nodeId:editor.id,parentId:editor.parentId,name:editor.name.trim()});}}>
      <label>{editor.id ? "目录名称" : editor.parentId ? "新建子目录" : "新建目录"}<input aria-label="目录名称" autoFocus maxLength={120} value={editor.name} disabled={busy} onChange={event => setEditor({...editor,name:event.target.value})}/></label>
      <div><button type="submit" disabled={blocked || !editor.name.trim()}>{busy ? "保存中…":"保存"}</button><button type="button" disabled={busy} onClick={() => setEditor(null)}>取消</button>{editor.id && <button type="button" disabled={blocked} title="只移除目录，内容移到上一层，资源不会删除" onClick={() => void work({operation:"delete",nodeId:editor.id})}>移除目录</button>}</div>
    </form>}
    {error && <p className="form-error" role="alert">{error}</p>}
    {render(null)}
    {!tree.length && <p className="nav-empty">暂无资源</p>}
    {dragging && <div data-resource-drop-inside="" className={`resource-root-drop ${drop?.id === "root" ? "drop-inside" : ""}`} onDragOver={event=>{event.preventDefault();setDrop({id:"root",zone:"inside"});}} onDrop={event=>{event.preventDefault();if(dragSource.current)move(dragSource.current,null);}}>移到资源根层</div>}
  </div></>;
}
