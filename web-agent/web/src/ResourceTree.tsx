import {createPortal} from "react-dom";
import {AppSelect} from "./AppSelect";
import {Glyph} from "./Icons";
import {BulkCheckbox, type BulkSelection} from "./BulkNavigationDelete";
import {NavigationMenu,type NavigationDeleteTarget} from "./NavigationDelete";
import { useEffect, useRef, useState, type DragEvent, type PointerEvent, type ReactNode, type RefObject } from "react";
import type { Project, Resource, ResourceTreeNode } from "../../shared/contracts";
import { api, readableError } from "./api";
import { canMoveInto, compareTreeNodes, dropPlacement, projectResourceTree, treeDropZone } from "./resource-tree-model";

type FolderEditor = {id?:string;parentId:string|null;name:string};
function ResourceFolderDialog({editor,location,busy,blocked,error,returnFocus,onChange,onSave,onClose}:{editor:FolderEditor;location:string;busy:boolean;blocked:boolean;error:string;returnFocus:RefObject<HTMLButtonElement|null>;onChange:(name:string)=>void;onSave:()=>void;onClose:()=>void}) {
  const dialog=useRef<HTMLDialogElement>(null),input=useRef<HTMLInputElement>(null);
  const title=editor.id ? "重命名目录" : editor.parentId ? "新建子目录" : "新建目录";
  useEffect(()=>{
    const node=dialog.current,previous=returnFocus.current;
    node?.showModal();input.current?.focus({preventScroll:true});input.current?.select();
    return()=>{node?.close();if(previous?.isConnected)previous.focus({preventScroll:true});};
  },[returnFocus]);
  return createPortal(<dialog ref={dialog} className="presentation-dialog resource-folder-dialog" aria-label={title} aria-busy={busy} onCancel={event=>{event.preventDefault();if(!busy)onClose();}}>
    <div className="presentation-dialog-head"><h2>{title}</h2><button type="button" className="icon-button" aria-label={`关闭${title}`} disabled={busy} onClick={onClose}><Glyph name="close" size={18}/></button></div>
    <p className="resource-folder-location">位置：{location}</p>
    <form className="resource-folder-editor" onKeyDown={event=>{if(event.key==='Enter'&&(event.nativeEvent.isComposing||event.nativeEvent.keyCode===229))event.preventDefault();}} onSubmit={event=>{event.preventDefault();if(!blocked&&editor.name.trim())onSave();}}>
      <label>目录名称<input ref={input} aria-label="目录名称" maxLength={120} value={editor.name} disabled={busy} onChange={event=>onChange(event.target.value)}/></label>
      {error&&<p className="form-error" role="alert">{error}</p>}
      <div><button type="button" className="button secondary" disabled={busy} onClick={onClose}>取消</button><button type="submit" className="button primary" disabled={blocked||!editor.name.trim()}>{busy?"保存中…":"保存"}</button></div>
    </form>
  </dialog>,document.body);
}
function FolderIcon() { return <Glyph name="folder" size={16} className="resource-tree-folder-icon"/>; }
export function ResourceTree({project, resources, nodes, disabled, renderResource, refresh, onAddResource, onImport, onDelete, selection, onSelectAll, filtering = false}: {
  filtering?: boolean;
  selection?: BulkSelection; onSelectAll?: () => void;
  project: Project; resources: Resource[]; nodes: ResourceTreeNode[]; disabled: boolean;
  renderResource: (resource: Resource) => ReactNode; refresh: () => Promise<unknown>; onAddResource: (parentId: string | null) => void; onImport: () => void; onDelete:(target:NavigationDeleteTarget)=>void;
}) {
  const tree = projectResourceTree(project.id, nodes, resources);
  const resourceMap = new Map(resources.map(resource => [resource.id, resource]));
  const nodeMap = new Map(tree.map(node => [node.id, node]));
  const children = new Map<string | null, ResourceTreeNode[]>();
  for (const node of tree) { const siblings = children.get(node.parentId) ?? []; siblings.push(node); children.set(node.parentId,siblings); }
  for (const siblings of children.values()) siblings.sort(compareTreeNodes);
  const childrenOf = (parent: string | null) => children.get(parent) ?? [];
  const [sectionExpanded, setSectionExpanded] = useState(() => {
    try { return localStorage.getItem(`lake.resource-section.${project.id}`) !== "closed"; } catch { return true; }
  });
  useEffect(() => { try { localStorage.setItem(`lake.resource-section.${project.id}`, sectionExpanded ? "open" : "closed"); } catch {} }, [project.id, sectionExpanded]);
  // Persist explicit expansions: absent/new folders stay collapsed, including after async loads.
  // The legacy key stored collapsed exceptions to an expanded default, so it is not reusable.
  const [expandedFolders, setExpandedFolders] = useState<string[]>(() => {
    try { const saved: unknown = JSON.parse(localStorage.getItem(`lake.resource-folders.expanded.${project.id}`) || "[]"); return Array.isArray(saved) ? saved.filter(id => typeof id === "string") : []; } catch { return []; }
  });
  useEffect(() => {try {localStorage.setItem(`lake.resource-folders.expanded.${project.id}`, JSON.stringify(expandedFolders));} catch {}}, [project.id, expandedFolders]);
  const [editor, setEditor] = useState<FolderEditor|null>(null);
  const [context,setContext]=useState<{id:string;x:number;y:number}|null>(null);
  const contextAnchor=useRef<HTMLButtonElement|null>(null);
  const editorAnchor=useRef<HTMLButtonElement|null>(null);
  const [moving, setMoving] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const dragSource = useRef<string | null>(null);
  const pointerDrag = useRef<{source:string; pointer:number; x:number; y:number; currentX:number; currentY:number; active:boolean; scroll:HTMLElement|null} | null>(null);
  const pointerDrop = useRef<{parentId:string|null; beforeId:string|null} | null>(null);
  const pointerUpdate=useRef<(x:number,y:number)=>void>(()=>{});
  const focusAfterMove=useRef<string|null>(null);
  const root=useRef<HTMLDivElement>(null);
  const suppressClick = useRef(false);
  const [drop, setDrop] = useState<{id: string; zone: "before" | "inside" | "after"} | null>(null);
  const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const blocked = disabled || busy || filtering;
  useEffect(()=>{
    if(!dragging||drop?.zone!=='inside'||drop.id==='root'||expandedFolders.includes(drop.id))return;
    const timer=setTimeout(()=>setExpandedFolders(values=>values.includes(drop.id)?values:[...values,drop.id]),600);
    return ()=>clearTimeout(timer);
  },[dragging,drop,expandedFolders]);
  useEffect(()=>{
    if(busy||!focusAfterMove.current)return;
    root.current?.querySelector<HTMLButtonElement>(`[data-resource-tree-node="${CSS.escape(focusAfterMove.current)}"] .resource-drag-handle`)?.focus();
    focusAfterMove.current=null;
  },[busy,nodes]);
  useEffect(()=>{
    if(!dragging)return;
    let frame=0;
    const cancel=()=>{suppressClick.current=true;pointerDrag.current=null;pointerDrop.current=null;dragSource.current=null;setDragging(null);setDrop(null);};
    const key=(event:KeyboardEvent)=>{if(event.key==='Escape'){event.preventDefault();cancel();}};
    const tick=()=>{
      const drag=pointerDrag.current,scroll=drag?.scroll;
      if(drag?.active&&scroll){
        const rect=scroll.getBoundingClientRect();
        if(drag.currentX>=rect.left&&drag.currentX<=rect.right){
          const edge=48;const speed=drag.currentY<rect.top+edge?-Math.min(12,(rect.top+edge-drag.currentY)/4):drag.currentY>rect.bottom-edge?Math.min(12,(drag.currentY-rect.bottom+edge)/4):0;
          if(speed){scroll.scrollTop+=speed;pointerUpdate.current(drag.currentX,drag.currentY);}
        }
      }
      frame=requestAnimationFrame(tick);
    };
    frame=requestAnimationFrame(tick);document.addEventListener('keydown',key);
    return ()=>{cancelAnimationFrame(frame);document.removeEventListener('keydown',key);};
  },[dragging]);
  useEffect(()=>{
    if(editor?.id && !nodes.some(node=>node.id===editor.id))setEditor(null);
    if(context && !tree.some(node=>node.id===context.id))setContext(null);
    if(moving && !tree.some(node=>node.id===moving))setMoving(null);
  },[nodes,resources,editor,context,moving]);
  const [addOpen, setAddOpen] = useState(false);
  const addControl = useRef<HTMLDivElement>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const addMenu = useRef<HTMLDivElement>(null);
  // 指针打开菜单时不移动焦点：程序化 focus 会让首项呈现悬停底色，看起来像未悬停就已被选中。
  const addFocusTarget = useRef<"first" | "last" | null>("first");
  useEffect(() => {
    if (!addOpen) return;
    if (blocked) { setAddOpen(false); return; }
    const items = Array.from(addMenu.current?.querySelectorAll<HTMLButtonElement>("button") ?? []);
    const target = addFocusTarget.current;
    if (target) (target === "last" ? items.at(-1) : items[0])?.focus();
    const dismiss = (event: globalThis.PointerEvent) => { if (!addControl.current?.contains(event.target as Node)) setAddOpen(false); };
    // 指针打开时焦点可能仍在原处，因此 Escape 在文档层处理，并只在焦点仍位于控件内时交还给触发按钮。
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault(); setAddOpen(false);
      if (addControl.current?.contains(document.activeElement)) addButton.current?.focus();
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", key);
    return () => { document.removeEventListener("pointerdown", dismiss); document.removeEventListener("keydown", key); };
  }, [addOpen, blocked]);
  const openEditor=(value:FolderEditor,anchor:HTMLButtonElement|null)=>{editorAnchor.current=anchor;setError("");setEditor(value);};
  const closeEditor=()=>{if(!busy){setEditor(null);setError("");}};
  const work = async (data: Parameters<typeof api.editResourceTree>[1]) => {
    if (blocked) return;
    setBusy(true); setError("");
    try { await api.editResourceTree(project.id, data); if(data.operation==="create"){setSectionExpanded(true);if(data.parentId)setExpandedFolders(values=>values.includes(data.parentId!)?values:[...values,data.parentId!]);} await refresh(); setEditor(null); setMoving(null); }
    catch (error) { setError(readableError(error)); }
    finally {setBusy(false); dragSource.current = null; setDragging(null); setDrop(null);}
  };
  const move = (source: string, parentId: string | null, beforeId: string | null = null) => {
    if (source === beforeId || !canMoveInto(tree, source, parentId)) return;
    if (parentId) setExpandedFolders(values => values.includes(parentId) ? values : [...values, parentId]);
    void work({operation:"move", nodeId:source, parentId, beforeId});
  };
  const placementMarker=(source:string,target:ResourceTreeNode,zone:'before'|'inside'|'after',place:{parentId:string|null;beforeId:string|null}):typeof drop=>{
    if(zone==='inside')return {id:target.id,zone};
    if(place.beforeId)return {id:place.beforeId,zone:'before'};
    const last=childrenOf(place.parentId).filter(node=>node.id!==source&&!node.builtin).at(-1);
    return last?{id:last.id,zone:'after'}:{id:place.parentId??'root',zone:'inside'};
  };
  // Pointer capture works for mouse, trackpad and touch, including browsers
  // whose embedded web view does not provide native HTML drag sessions.
  const updatePointerDrop = (x:number,y:number) => {
    const drag = pointerDrag.current;
    if (!drag||blocked)return;
    const target = document.elementFromPoint(x,y);
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
        const bounds=row.getBoundingClientRect();const ratio=(y-bounds.top)/Math.max(1,bounds.height);
        const zone=treeDropZone(node,ratio,x-bounds.left);
        const candidate=dropPlacement(tree,node,zone,drag.source);
        if(canMoveInto(tree,drag.source,candidate.parentId)){place=candidate;marker=placementMarker(drag.source,node,zone,candidate);}
      }
    }
    pointerDrop.current=place;
    setDrop(current=>current?.id===marker?.id && current?.zone===marker?.zone ? current:marker);
  };
  pointerUpdate.current=updatePointerDrop;
  const pointerMove = (event: PointerEvent<HTMLButtonElement>) => {
    const drag=pointerDrag.current;if(!drag||drag.pointer!==event.pointerId||blocked)return;
    drag.currentX=event.clientX;drag.currentY=event.clientY;
    if(!drag.active&&Math.hypot(event.clientX-drag.x,event.clientY-drag.y)<5)return;
    if(!drag.active){drag.active=true;dragSource.current=drag.source;setDragging(drag.source);}
    updatePointerDrop(event.clientX,event.clientY);
  };
  const pointerEnd = (event: PointerEvent<HTMLButtonElement>, cancelled = false) => {
    const drag=pointerDrag.current;
    if(!drag || drag.pointer!==event.pointerId)return;
    pointerDrag.current=null;
    if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);
    const place=pointerDrop.current;pointerDrop.current=null;
    if(drag.active){suppressClick.current=true;if(!cancelled && place)move(drag.source,place.parentId,place.beforeId);}
    dragSource.current=null;setDragging(null);setDrop(null);
  };
  const dragOver = (event: DragEvent<HTMLElement>, node: ResourceTreeNode) => {
    const source = dragSource.current;
    if (!source || blocked || source === node.id) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const ratio = (event.clientY - bounds.top) / Math.max(1, bounds.height);
    const zone = treeDropZone(node,ratio,event.clientX-bounds.left);
    const placement = dropPlacement(tree, node, zone,source);
    if (!canMoveInto(tree, source, placement.parentId)) return;
    event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = "move";
    const marker=placementMarker(source,node,zone,placement);
    setDrop(current => current?.id === marker?.id && current?.zone === marker?.zone ? current : marker);
  };
  const render = (parent: string | null, depth = 0): ReactNode => childrenOf(parent).map(node => {
    const resource = node.resourceId ? resourceMap.get(node.resourceId) : undefined;
    const builtin = resource?.kind === "local";
    const expanded = filtering || expandedFolders.includes(node.id);
    const siblings = childrenOf(parent).filter(item=>item.kind===node.kind&&!item.builtin); const index = siblings.findIndex(item => item.id === node.id);
    return <div className={`resource-tree-node ${dragging === node.id ? "is-dragging" : ""}`} key={node.id}>
      <div data-resource-tree-node={node.id} onContextMenu={event=>{event.preventDefault();event.stopPropagation();if(!blocked && !builtin){contextAnchor.current=event.currentTarget.querySelector<HTMLButtonElement>('.navigation-more-button') ?? event.currentTarget.querySelector<HTMLButtonElement>('.resource-drag-handle');setContext({id:node.id,x:event.clientX,y:event.clientY});}}} className={`resource-tree-row ${drop?.id === node.id ? `drop-${drop.zone}` : ""}`} onDragOver={event => dragOver(event,node)} onDrop={event => {
        event.preventDefault(); event.stopPropagation();
        const source = dragSource.current || event.dataTransfer.getData("application/x-lake-resource-tree");
        if (!source || source === node.id || blocked) return;
        const bounds = event.currentTarget.getBoundingClientRect();
        const ratio = (event.clientY - bounds.top) / Math.max(1,bounds.height);
        const zone = treeDropZone(node,ratio,event.clientX-bounds.left);
        const target = dropPlacement(tree,node,zone,source); move(source,target.parentId,target.beforeId);
      }}>
        {!builtin && (node.kind === "folder" || resource) && <BulkCheckbox selection={selection} target={node.kind === "folder" ? {kind:"folder",id:node.id,projectId:project.id,name:folderPath(node)} : {kind:"resource",id:resource!.id,projectId:project.id,name:resource!.name}}/>}
        {!builtin && <button type="button" className="resource-drag-handle" aria-label={`拖动或移动 ${resource?.name || node.name}`} title="上下拖动排序，向右拖入目录；也可按上下方向键或点击选择位置" disabled={blocked} draggable={false}
          onClick={() => {if(suppressClick.current){suppressClick.current=false;return;}setMoving(current => current === node.id ? null : node.id);}}
          onKeyDown={event=>{if(event.key==='Enter'||event.key===' '){suppressClick.current=false;return;}if(blocked||!['ArrowUp','ArrowDown'].includes(event.key))return;event.preventDefault();const next=event.key==='ArrowUp'?index-1:index+1;if(next<0||next>=siblings.length)return;focusAfterMove.current=node.id;move(node.id,parent,event.key==='ArrowUp'?siblings[next]!.id:siblings[next+1]?.id??null);}}
          onPointerDown={event=>{if(blocked || event.button!==0)return;event.preventDefault();suppressClick.current=false;event.currentTarget.setPointerCapture(event.pointerId);pointerDrag.current={source:node.id,pointer:event.pointerId,x:event.clientX,y:event.clientY,currentX:event.clientX,currentY:event.clientY,active:false,scroll:event.currentTarget.closest<HTMLElement>('.project-scroll')};pointerDrop.current=null;}}
          onPointerMove={pointerMove} onPointerUp={event=>pointerEnd(event)} onPointerCancel={event=>pointerEnd(event,true)} onLostPointerCapture={event=>pointerEnd(event,true)}
          onDragStart={event => {dragSource.current = node.id;event.dataTransfer.setData("application/x-lake-resource-tree",node.id);event.dataTransfer.effectAllowed="move";setDragging(node.id);setError("");}} onDragEnd={() => {dragSource.current = null;setDragging(null);setDrop(null);}}><Glyph name="grip" size={12}/></button>}
        {node.kind === "folder" ? <div className="resource-folder-row">
          <button type="button" className="resource-folder-toggle" title={folderPath(node)} aria-expanded={expanded} onClick={() => setExpandedFolders(values => expanded ? values.filter(id => id !== node.id) : [...values,node.id])}><Glyph name="chevron" size={11} className={expanded ? "folder-chevron open" : "folder-chevron"}/><FolderIcon/><span className="resource-folder-name">{node.name}</span><small className="resource-folder-count" title={`${childrenOf(node.id).length} 个子项`}>{childrenOf(node.id).length}</small></button>
          <div className="resource-folder-actions"><button type="button" className="navigation-more-button" disabled={blocked} aria-label={`管理文件夹 ${folderPath(node)}`} aria-haspopup="menu" title="更多操作" onClick={event => {contextAnchor.current=event.currentTarget;const rect=event.currentTarget.getBoundingClientRect();setContext({id:node.id,x:rect.right-208,y:rect.bottom+6});}}><Glyph name="more" size={15}/></button></div>
        </div> : resource && <><div className="resource-tree-resource-content">{renderResource(resource)}</div>{!["local", "ssh"].includes(resource.kind) && <button type="button" className="navigation-more-button resource-more-button" disabled={blocked} aria-label={`管理资源 ${resource.name}`} aria-haspopup="menu" title="更多操作" onClick={event=>{contextAnchor.current=event.currentTarget;const rect=event.currentTarget.getBoundingClientRect();setContext({id:node.id,x:rect.right-208,y:rect.bottom+6});}}><Glyph name="more" size={15}/></button>}</>}
      </div>
      {moving === node.id && !builtin && <div className="resource-move-panel" role="group" aria-label={`移动 ${resource?.name || node.name}`}>
        <div><button disabled={blocked || index === 0 || !!siblings[index-1]?.builtin} onClick={() => move(node.id,parent,siblings[index-1]?.id ?? null)}>上移</button><button disabled={blocked || index === siblings.length-1} onClick={() => move(node.id,parent,siblings[index+2]?.id ?? null)}>下移</button></div>
        <label>移到目录<AppSelect aria-label={`将 ${resource?.name || node.name} 移到目录`} value="" disabled={blocked} onChange={event => {if(event.target.value) move(node.id,event.target.value === "root" ? null : event.target.value);}}><option value="">选择位置…</option><option value="root">资源根层</option>{tree.filter(folder => folder.kind === "folder" && canMoveInto(tree,node.id,folder.id)).map(folder => <option value={folder.id} key={folder.id}>{folderPath(folder)}</option>)}</AppSelect></label>
      </div>}
      {node.kind === "folder" && expanded && depth < 32 && <div className="resource-folder-children" style={depth>=4 ? {marginLeft:0,paddingLeft:0,borderLeft:0}:undefined}>{render(node.id,depth+1)}{!childrenOf(node.id).length && <div data-resource-drop-inside={node.id} className={`resource-folder-empty ${drop?.id === node.id ? "drop-inside" : ""}`} onDragOver={event => {if(dragSource.current && canMoveInto(tree,dragSource.current,node.id)){event.preventDefault();event.stopPropagation();setDrop({id:node.id,zone:"inside"});}}} onDrop={event => {event.preventDefault();event.stopPropagation();if(dragSource.current)move(dragSource.current,node.id);}}>拖动资源到这里</div>}</div>}
    </div>;
  });
  function folderPath(folder: ResourceTreeNode) {
    const names=[folder.name];let parent=folder.parentId;const seen=new Set([folder.id]);
    while(parent && !seen.has(parent)){seen.add(parent);const node=nodeMap.get(parent);if(!node)break;names.unshift(node.name);parent=node.parentId;}
    return names.join(" / ");
  }
  const contextNode=context ? nodeMap.get(context.id) : undefined;
  const contextResource=contextNode?.resourceId ? resourceMap.get(contextNode.resourceId) : undefined;
  return <>{context && contextNode && <NavigationMenu title={contextResource?.name || contextNode.name} anchor={contextAnchor} x={context.x} y={context.y} onClose={()=>setContext(null)} actions={[
   ...(contextNode.kind==="folder" ? [
    {label:"新建资源",icon:"server" as const,disabled:blocked,run:()=>onAddResource(contextNode.id)},
    {label:"新建子目录",icon:"folder" as const,disabled:blocked,run:()=>openEditor({parentId:contextNode.id,name:""},contextAnchor.current)},
    {label:"重命名",icon:"edit" as const,separatorBefore:true,run:()=>openEditor({id:contextNode.id,parentId:contextNode.parentId,name:contextNode.name},contextAnchor.current)}
   ] : []),
   {label:"移动到…",icon:"arrow",run:()=>setMoving(contextNode.id)},
   {label:contextNode.kind==="folder"?"删除目录":"删除资源",icon:"trash",separatorBefore:true,danger:true,run:()=>onDelete({kind:contextNode.kind,id:contextResource?.id || contextNode.id,projectId:project.id,name:contextResource?.name || contextNode.name})}
  ]}/>}<div className="nav-heading resources-heading"><button type="button" className="nav-section-toggle" aria-label={`${sectionExpanded ? "折叠" : "展开"}${project.name}的资源`} aria-expanded={sectionExpanded} aria-controls={`project-resources-${project.id}`} onClick={() => setSectionExpanded(value => !value)}><Glyph name="chevron" size={13} className={`resource-section-chevron ${sectionExpanded ? "chevron-open" : ""}`}/><span className="resource-section-label">资源 <small>{resources.length}</small></span></button>{selection && <button type="button" className="bulk-group-toggle" disabled={blocked || selection.disabled || !resources.length && !tree.length} aria-label={`全选 ${project.name} 的资源和文件夹`} onClick={onSelectAll}>全选</button>}<div hidden={!!selection} className="resource-add-control" ref={addControl} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setAddOpen(false); }}>
    <button type="button" ref={addButton} className="nav-add resource-create-trigger" aria-label={`在${project.name}新建资源或目录`} title="新建资源或目录" aria-haspopup="menu" aria-expanded={addOpen} aria-controls={`resource-add-${project.id}`} disabled={blocked} onPointerDown={() => { addFocusTarget.current = null; }} onKeyDown={event => {
      // Enter/Space 交给按钮原生激活（随后触发 onClick），避免再手动切换造成双重开关。
      if (event.key === "Enter" || event.key === " ") { addFocusTarget.current = "first"; return; }
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      event.preventDefault();
      addFocusTarget.current = event.key === "ArrowUp" ? "last" : "first";
      if (!addOpen) { setAddOpen(true); return; }
      const items = Array.from(addMenu.current?.querySelectorAll<HTMLButtonElement>("button") ?? []);
      (event.key === "ArrowDown" ? items[0] : items.at(-1))?.focus();
    }} onClick={() => setAddOpen(value => !value)}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg><span>新建</span></button>
    {addOpen && <div ref={addMenu} id={`resource-add-${project.id}`} className="resource-add-menu" role="menu" aria-label="新建资源或目录" onMouseDown={event => {
      // Safari 点击按钮时会先 blur 到 body；保留菜单焦点，避免 onBlur 在 click 前卸载菜单。
      if (event.button === 0) event.preventDefault();
    }} onKeyDown={event => {
      if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        event.preventDefault(); const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button")); const index = items.indexOf(document.activeElement as HTMLButtonElement);
        items[event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (index + (event.key === "ArrowUp" ? -1 : 1) + items.length) % items.length]?.focus();
      }
    }}>
      <button type="button" role="menuitem" onClick={() => { setAddOpen(false); onAddResource(null); }}><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><rect x="3" y="3" width="18" height="7" rx="1.5"/><rect x="3" y="14" width="18" height="7" rx="1.5"/><path d="M7 6.5h.01M7 17.5h.01M11 6.5h7M11 17.5h7"/></svg><span>新建资源</span></button>
      <button type="button" role="menuitem" onClick={() => { setAddOpen(false); onImport(); }}><FolderIcon/><span>导入资源</span></button>
      <button type="button" role="menuitem" onClick={() => { setAddOpen(false); openEditor({parentId:null,name:""},addButton.current); }}><FolderIcon/>新建目录</button>
    </div>}
  </div></div>{(sectionExpanded || filtering) && <div id={`project-resources-${project.id}`} className="resource-tree" ref={root} aria-label={`${project.name} 资源目录`}>
    {error&&!editor&&<p className="form-error" role="alert">{error}</p>}
    {dragging && <div className="resource-drag-status" role="status">{drop ? `${drop.zone==='inside'?'移入':drop.zone==='before'?'排在前面：':'排在后面：'}${drop.id==='root'?'资源根层':resourceMap.get(nodeMap.get(drop.id)?.resourceId??'')?.name??nodeMap.get(drop.id)?.name??''}` : '上下拖动排序，向右拖入目录'} · Esc 取消</div>}
    {render(null)}
    {!tree.length && <p className="nav-empty">暂无资源</p>}
    {dragging && <div data-resource-drop-inside="" className={`resource-root-drop ${drop?.id === "root" ? "drop-inside" : ""}`} onDragOver={event=>{event.preventDefault();setDrop({id:"root",zone:"inside"});}} onDrop={event=>{event.preventDefault();if(dragSource.current)move(dragSource.current,null);}}>移到资源根层</div>}
  </div>}
  {editor&&<ResourceFolderDialog editor={editor} location={[project.name,editor.parentId&&nodeMap.get(editor.parentId)?folderPath(nodeMap.get(editor.parentId)!):"资源根层"].join(" / ")} busy={busy} blocked={blocked} error={error} returnFocus={editorAnchor} onChange={name=>setEditor({...editor,name})} onClose={closeEditor} onSave={()=>void work({operation:editor.id?"rename":"create",nodeId:editor.id,parentId:editor.parentId,name:editor.name.trim()})}/>}
  </>;
}
