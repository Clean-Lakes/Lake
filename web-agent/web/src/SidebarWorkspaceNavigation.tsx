import {useEffect,useId,useRef,useState,type ReactNode} from 'react';
import {SidebarScrollArea} from './SidebarScrollArea';
import {SidebarResourceActions} from './SidebarResourceActions';
import {Glyph} from './Icons';

type NavigationPanel = 'specialists'|'resources';

/** Both lists stay mounted so switching preserves their scroll and folder state. */
export function SidebarWorkspaceNavigation({projectId,pilot,specialists,children,resourceCount,selectionId,selectedPanel,attention=false,onLeaveResources}:{
 projectId:string;pilot:ReactNode;specialists:ReactNode;children:ReactNode;resourceCount:number;
 selectionId:string;selectedPanel:NavigationPanel;attention?:boolean;onLeaveResources?:()=>void;
}) {
 const id=useId();
 const [resourceActions,setResourceActions]=useState<HTMLElement|null>(null);
 const [panel,setPanel]=useState<NavigationPanel>(()=>{
  if(selectedPanel==='resources')return 'resources';
  try{return localStorage.getItem(`lake.sidebar-panel.${projectId}`)==='resources'?'resources':'specialists';}catch{return 'specialists';}
 });
 const previousSelection=useRef(selectionId);
 useEffect(()=>{
  if(previousSelection.current===selectionId)return;
  previousSelection.current=selectionId;setPanel(selectedPanel);
 },[selectionId,selectedPanel]);
 useEffect(()=>{try{localStorage.setItem(`lake.sidebar-panel.${projectId}`,panel);}catch{}},[projectId,panel]);
 const resourcesOpen=panel==='resources';
 return <div className="sidebar-workspace-navigation">
  <nav className="sidebar-navigation-rail" aria-label="侧栏视图">
   <button type="button" className="sidebar-rail-button" aria-label="专员" aria-pressed={!resourcesOpen}
    aria-controls={`${id}-specialists-panel`} title="专员"
    onClick={()=>{setPanel('specialists');if(resourcesOpen)onLeaveResources?.();}}><Glyph name="users" size={18}/></button>
   <button type="button" className="sidebar-rail-button" aria-label="资源" aria-pressed={resourcesOpen}
    aria-controls={`${id}-resources-panel`} title="资源" onClick={()=>setPanel('resources')}><Glyph name="layers" size={18}/></button>
  </nav>
  <section className="sidebar-navigation-panel" id={`${id}-specialists-panel`} aria-labelledby={`${id}-specialists-title`} hidden={resourcesOpen}>
   {!resourcesOpen&&<div className="sidebar-pinned-pilot">{pilot}</div>}
   <div className="sidebar-content-header">
    <div className="sidebar-content-title">
     <h2 id={`${id}-specialists-title`}>专员</h2>
     {attention&&<span className="sidebar-specialist-attention" role="img" aria-label="专员有待确认事项或未读消息"/>}
    </div>
   </div>
   <SidebarScrollArea>{specialists}</SidebarScrollArea>
  </section>
  <section className="sidebar-navigation-panel sidebar-resources-panel" id={`${id}-resources-panel`} aria-labelledby={`${id}-resources-title`} hidden={!resourcesOpen}>
   <div className="sidebar-content-header">
    <div className="sidebar-content-title"><h2 id={`${id}-resources-title`}>资源</h2><small>{resourceCount}</small></div>
    <div ref={setResourceActions} className="sidebar-resource-actions"/>
   </div>
   <SidebarResourceActions.Provider value={resourceActions}>
    <SidebarScrollArea>{children}</SidebarScrollArea>
   </SidebarResourceActions.Provider>
  </section>
 </div>;
}
