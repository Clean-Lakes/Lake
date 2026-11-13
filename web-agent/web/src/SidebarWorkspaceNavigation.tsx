import {useEffect,useId,useRef,useState,type ReactNode} from 'react';
import {SidebarScrollArea} from './SidebarScrollArea';
import {SidebarResourceActions} from './SidebarResourceActions';

type NavigationPanel = 'specialists'|'resources';

/** Both lists stay mounted so switching preserves their scroll and folder state. */
export function SidebarWorkspaceNavigation({projectId,pilot,specialists,children,resourceCount,selectionId,selectedPanel,attention=false}:{
 projectId:string;pilot:ReactNode;specialists:ReactNode;children:ReactNode;resourceCount:number;
 selectionId:string;selectedPanel:NavigationPanel;attention?:boolean;
}) {
 const id=useId(),tabs=useRef(new Map<NavigationPanel,HTMLButtonElement>());
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
 return <div className="sidebar-workspace-navigation">
  <div className="sidebar-pinned-pilot">{pilot}</div>
  <div className="sidebar-content-header">
   <div className="sidebar-content-tabs" role="tablist" aria-label="项目导航内容">
   {(['specialists','resources'] as const).map(value=><button type="button" key={value} ref={node=>{if(node)tabs.current.set(value,node);else tabs.current.delete(value);}}
    role="tab" id={`${id}-${value}-tab`} aria-controls={`${id}-${value}-panel`} aria-selected={panel===value} tabIndex={panel===value?0:-1}
    className="sidebar-content-tab" onClick={()=>setPanel(value)} onKeyDown={event=>{
     if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
     event.preventDefault();const next=event.key==='Home'?'specialists':event.key==='End'?'resources':value==='specialists'?'resources':'specialists';
     setPanel(next);tabs.current.get(next)?.focus();
    }}>
    <span>{value==='specialists'?'专员':'资源'}</span>
    {value==='resources'&&<small>{resourceCount}</small>}
    {value==='specialists'&&attention&&<span className="sidebar-specialist-attention" role="img" aria-label="专员有待确认事项或未读消息"/>}
   </button>)}
   </div>
   <div ref={setResourceActions} className={`sidebar-resource-actions${panel==='resources'?' is-active':''}`} aria-hidden={panel!=='resources'} inert={panel!=='resources'}/>
  </div>
  <SidebarResourceActions.Provider value={resourceActions}>
  <section className="sidebar-navigation-panel" role="tabpanel" id={`${id}-specialists-panel`} aria-labelledby={`${id}-specialists-tab`} hidden={panel!=='specialists'}>
   <SidebarScrollArea>{specialists}</SidebarScrollArea>
  </section>
  <section className="sidebar-navigation-panel sidebar-resources-panel" role="tabpanel" id={`${id}-resources-panel`} aria-labelledby={`${id}-resources-tab`} hidden={panel!=='resources'}>
   <SidebarScrollArea>{children}</SidebarScrollArea>
  </section>
  </SidebarResourceActions.Provider>
 </div>;
}
