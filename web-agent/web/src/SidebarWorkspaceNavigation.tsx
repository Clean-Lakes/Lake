import {useContext,useEffect,useId,useRef,useState,type ReactNode} from 'react';
import {SidebarScrollArea} from './SidebarScrollArea';
import {SidebarResourceActions} from './SidebarResourceActions';
import {Glyph} from './Icons';
import {NavigationMenu} from './NavigationDelete';
import {WorkbenchSidebar} from './WorkbenchNavigation';

type NavigationPanel = 'specialists'|'resources';
type WorkspaceNavigation = {
 active:boolean;modelConfigured:boolean;unreadUpdate:boolean;
 onProjects:()=>void;onSettings:()=>void;onUpdates:()=>void;
};

function initialPanel(projectId:string|undefined,selected:NavigationPanel):NavigationPanel {
 if(selected==='resources')return 'resources';
 if(projectId)try{if(localStorage.getItem(`lake.sidebar-panel.${projectId}`)==='resources')return 'resources';}catch{}
 return 'specialists';
}

/** Both lists stay mounted so switching preserves their scroll and folder state. */
export function SidebarWorkspaceNavigation({projectId,specialists,children,resourceCount,selectionId,selectedPanel,attention=false,onSelectPanel,workspace,empty,header,contentId}:{
 projectId?:string;specialists:ReactNode;children:ReactNode;resourceCount:number;
 selectionId:string;selectedPanel:NavigationPanel;attention?:boolean;onSelectPanel?:(panel:NavigationPanel)=>void;workspace?:WorkspaceNavigation;empty?:ReactNode;
 header?:ReactNode;contentId?:string;
}) {
 const id=useId();
 const {collapsed,expand}=useContext(WorkbenchSidebar);
 const workspaceButton=useRef<HTMLButtonElement>(null);
 const [workspaceMenuOpen,setWorkspaceMenuOpen]=useState(false);
 const [resourceActions,setResourceActions]=useState<HTMLElement|null>(null);
 const [selection,setSelection]=useState(()=>({projectId,selectionId,panel:initialPanel(projectId,selectedPanel)}));
 const {panel}=selection;
 if(projectId!==selection.projectId||selectionId!==selection.selectionId){
  setSelection({projectId,selectionId,panel:projectId!==selection.projectId?initialPanel(projectId,selectedPanel):selectedPanel});
 }
 const selectPanel=(panel:NavigationPanel)=>{expand();setSelection({...selection,panel});onSelectPanel?.(panel);};
 useEffect(()=>{if(projectId)try{localStorage.setItem(`lake.sidebar-panel.${projectId}`,panel);}catch{}},[projectId,panel]);
 useEffect(()=>{setWorkspaceMenuOpen(false);},[selectionId,workspace?.active]);
 const specialistsOpen=!workspace?.active&&panel==='specialists';
 const resourcesOpen=!workspace?.active&&panel==='resources';
 return <div className="sidebar-workspace-navigation">
  <nav className="sidebar-navigation-rail" aria-label="侧栏视图">
   {projectId&&<><button type="button" className="sidebar-rail-button" aria-label={attention?'专员，有待确认事项或未读消息':'专员'} aria-pressed={specialistsOpen}
    aria-controls={`${id}-specialists-panel`} title="专员"
    onClick={()=>selectPanel('specialists')}>
    <Glyph name="lakeSpecialists" size={22} filled={specialistsOpen}/>{attention&&<span className="sidebar-specialist-attention" aria-hidden="true"/>}
   </button>
   <button type="button" className="sidebar-rail-button" aria-label="资源" aria-pressed={resourcesOpen}
    aria-controls={`${id}-resources-panel`} title="资源" onClick={()=>selectPanel('resources')}><Glyph name="lakeResources" size={22} filled={resourcesOpen}/></button></>}
   {workspace&&<button ref={workspaceButton} type="button" className="sidebar-rail-button workspace-rail-button" aria-label={workspace.unreadUpdate?'工作区，有新版本':'工作区'}
    aria-current={workspace.active?'page':undefined} aria-haspopup="menu" aria-expanded={workspaceMenuOpen}
    aria-controls={workspaceMenuOpen?`${id}-workspace-menu`:undefined} title="工作区" onClick={()=>setWorkspaceMenuOpen(open=>!open)}
    onKeyDown={event=>{if(event.key==='ArrowDown'){event.preventDefault();setWorkspaceMenuOpen(true);}}}>
    <Glyph name="lakeWorkspace" size={22} filled={workspace.active||workspaceMenuOpen}/>{workspace.unreadUpdate&&<span className="workspace-update-dot" aria-hidden="true"/>}
   </button>}
  </nav>
  {workspace&&workspaceMenuOpen&&<NavigationMenu id={`${id}-workspace-menu`} title="工作区" className="workspace-actions-menu"
   anchor={workspaceButton} placement="above" onClose={()=>setWorkspaceMenuOpen(false)} actions={[
    {label:'项目',icon:'folder',current:workspace.active,run:workspace.onProjects},
    {label:'设置',icon:'settings',description:workspace.modelConfigured?undefined:'待配置',run:workspace.onSettings},
    {label:'检查更新',icon:'refresh',description:workspace.unreadUpdate?'新版本':undefined,run:workspace.onUpdates},
   ]}/>}
  <div className="sidebar-navigation-viewport">
   <div id={contentId} className="sidebar-navigation-content" inert={collapsed} aria-hidden={collapsed||undefined}>
    {header}
    {projectId?<><section key={`specialists:${projectId}`} className="sidebar-navigation-panel" id={`${id}-specialists-panel`} aria-label="专员" hidden={!specialistsOpen}>
     <SidebarScrollArea>{specialists}</SidebarScrollArea>
    </section>
    <section key={`resources:${projectId}`} className="sidebar-navigation-panel sidebar-resources-panel" id={`${id}-resources-panel`} aria-labelledby={`${id}-resources-title`} hidden={!resourcesOpen}>
     <div className="sidebar-content-header">
      <div className="sidebar-content-title"><h2 id={`${id}-resources-title`}>资源</h2><small>{resourceCount}</small></div>
      <div ref={setResourceActions} className="sidebar-resource-actions"/>
     </div>
     <SidebarResourceActions.Provider value={resourceActions}>
      <SidebarScrollArea>{children}</SidebarScrollArea>
     </SidebarResourceActions.Provider>
    </section></>:!workspace?.active&&<SidebarScrollArea>{empty}</SidebarScrollArea>}
   </div>
  </div>
 </div>;
}
