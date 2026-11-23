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
  <nav className="sidebar-resource-rail" aria-label="资源导航">
   <button type="button" className="sidebar-resource-rail-toggle" aria-label="资源" aria-pressed={resourcesOpen}
    aria-controls={`${id}-resources-panel`} title={resourcesOpen?'返回会话侧栏':'打开资源'}
    onClick={()=>{setPanel(resourcesOpen?'specialists':'resources');if(resourcesOpen)onLeaveResources?.();}}><Glyph name="layers" size={18}/></button>
  </nav>
  {!resourcesOpen&&<div className="sidebar-pinned-pilot">{pilot}</div>}
  <div className="sidebar-content-header">
   <div className="sidebar-content-title">
    <h2 id={`${id}-panel-title`}>{resourcesOpen?'资源':'专员'}</h2>
    {resourcesOpen?<small>{resourceCount}</small>:attention&&<span className="sidebar-specialist-attention" role="img" aria-label="专员有待确认事项或未读消息"/>}
   </div>
   <div ref={setResourceActions} className="sidebar-resource-actions" hidden={!resourcesOpen}/>
  </div>
  <SidebarResourceActions.Provider value={resourceActions}>
  <section className="sidebar-navigation-panel" aria-labelledby={`${id}-panel-title`} hidden={resourcesOpen}>
   <SidebarScrollArea>{specialists}</SidebarScrollArea>
  </section>
  <section className="sidebar-navigation-panel sidebar-resources-panel" id={`${id}-resources-panel`} aria-labelledby={`${id}-panel-title`} hidden={!resourcesOpen}>
   <SidebarScrollArea>{children}</SidebarScrollArea>
  </section>
  </SidebarResourceActions.Provider>
 </div>;
}
