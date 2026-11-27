import {useEffect,useLayoutEffect,useRef,useState,type PointerEvent as ReactPointerEvent,type ReactNode} from 'react';
import './workbenchIsland.css';
import {workbenchIslandLayout,type IslandPosition} from './workbenchIslandLayout';
import {
  expandedIslandWidth,
  ISLAND_DRAG_CANCEL_PX,
  ISLAND_LONG_PRESS_MS,
  ISLAND_PRESS_SWELL_MS,
  isInteractiveIslandTarget,
  type IslandPressState,
} from './lakeIslandPress';

export function useWideWorkbench(){
 const [wide,setWide]=useState(()=>matchMedia('(min-width:1101px)').matches);
 useEffect(()=>{const query=matchMedia('(min-width:1101px)');const update=()=>setWide(query.matches);update();query.addEventListener('change',update);return()=>query.removeEventListener('change',update);},[]);
 return wide;
}

type IslandBox=IslandPosition&{top:number};
type IslandFlight={open?:boolean;target?:IslandBox;animation?:Animation;deadline?:number};
const sameBox=(a:IslandBox|undefined,b:IslandBox)=>!!a&&Math.abs(a.left-b.left)<.5&&Math.abs(a.top-b.top)<.5&&Math.abs(a.width-b.width)<.5;

/** The terminal island separates from the conversation; the inspector owns its card header. */
export function WorkbenchIsland({
  conversation,
  terminal,
  activity,
  terminalOpen,
  pilotTone,
  sessionKey,
  expandedPanel,
}: {
  conversation:ReactNode;
  terminal:ReactNode;
  activity:ReactNode;
  terminalOpen:boolean;
  pilotTone?:string;
  sessionKey?:string;
  expandedPanel?:(controls:{close:()=>void})=>ReactNode;
}){
 const root=useRef<HTMLDivElement>(null),conversationIsland=useRef<HTMLDivElement>(null),terminalIsland=useRef<HTMLDivElement>(null);
 const interactive=!!expandedPanel;
 const [expanded,setExpanded]=useState(false);
 const [press,setPress]=useState<IslandPressState>('idle');
 const expandedRef=useRef(expanded);
 expandedRef.current=expanded;
 const pressTimers=useRef<{swell?:number;longPress?:number}>({});
 const pressState=useRef<{active:boolean;id:number;x:number;y:number;downAt:number}>({active:false,id:-1,x:0,y:0,downAt:0});
 const clearPressTimers=()=>{
  window.clearTimeout(pressTimers.current.swell);
  window.clearTimeout(pressTimers.current.longPress);
  pressTimers.current={};
 };
 const cancelPress=()=>{
  clearPressTimers();
  pressState.current.active=false;
  setPress('idle');
 };
 useEffect(()=>{setExpanded(false);cancelPress();},[sessionKey,interactive]);
 useEffect(()=>{
  if(!expanded)return;
  const onPointerDown=(event:PointerEvent)=>{
   const node=conversationIsland.current;
   if(node&&event.target instanceof Node&&!node.contains(event.target))setExpanded(false);
  };
  const onKeyDown=(event:KeyboardEvent)=>{
   if(event.key==='Escape')setExpanded(false);
  };
  window.addEventListener('pointerdown',onPointerDown);
  window.addEventListener('keydown',onKeyDown);
  return()=>{
   window.removeEventListener('pointerdown',onPointerDown);
   window.removeEventListener('keydown',onKeyDown);
  };
 },[expanded]);
 useEffect(()=>cancelPress,[]);
 const open=useRef({terminal:terminalOpen});
 open.current={terminal:terminalOpen};
 const scheduleLayout=useRef<()=>void>(()=>{});
 useLayoutEffect(()=>{
  const element=root.current,shell=element?.closest<HTMLElement>('.app-shell'),identity=conversationIsland.current;
  if(!element||!shell||!identity)return;
  let frame=0;
  let previousRoster:HTMLElement|null=null, previousRosterWidth=0, previousIslandWidth=0, previousExpanded=expandedRef.current;
  let rosterAnimation:Animation|undefined;
  let sidebarAnimation:Animation|undefined;
  let sidebarDeadline=0,previousLeft=0;
  let sidebarCollapsed=shell.classList.contains('has-collapsed-sidebar');
  const reduced=matchMedia('(prefers-reduced-motion:reduce)');
  const textMetrics=document.createElement('canvas').getContext('2d');
  const flights:Record<'terminal',IslandFlight>={terminal:{}};
  const observed=new Set<Element>();
  const write=(node:HTMLElement,box:IslandBox,useCssAnchor=false)=>{node.style.left=useCssAnchor?'':`${box.left}px`;node.style.top=`${box.top}px`;node.style.width=`${box.width}px`;};
  const present=(node:HTMLElement,value:boolean)=>{node.dataset.present=String(value);node.dataset.ready='true';};
  const move=(name:'terminal',node:HTMLElement,goal:IslandBox|undefined,source:IslandBox,base:DOMRect)=>{
   const flight=flights[name],expanded=open.current[name],changed=flight.open!==expanded;
   if(!expanded&&flight.open===undefined){flight.open=false;present(node,false);return;}
   if(!expanded&&!flight.open&&!flight.animation)return;
   // Keep text at its final size. Only the composited translation and opacity
   // change during flight; animating width would reflow all controls each frame.
   const target=expanded?goal:{...source,width:flight.target?.width??node.offsetWidth};
   if(!target)return;
   if(reduced.matches||document.documentElement.classList.contains('workbench-resizing')){
    flight.animation?.cancel();flight.animation=undefined;flight.open=expanded;flight.target=target;write(node,target);present(node,expanded);delete node.dataset.moving;return;
   }
   if(!changed&&!flight.animation){write(node,target);flight.target=target;present(node,expanded);return;}
   if(!changed&&sameBox(flight.target,target))return;
   const bounds=node.getBoundingClientRect();
   const from=expanded&&!flight.animation&&changed?source:{left:bounds.left-base.left,top:bounds.top-base.top,width:bounds.width};
   const opacity=expanded&&!flight.animation&&changed ? .15 : Number(getComputedStyle(node).opacity);
   flight.animation?.cancel();
   if(changed)flight.deadline=performance.now()+(expanded?380:280);
   const duration=Math.max(1,(flight.deadline??performance.now())-performance.now());
   flight.open=expanded;flight.target=target;
   write(node,target);present(node,true);node.dataset.moving='true';
   const animation=node.animate([
    {transform:`translate3d(${from.left-target.left}px,${from.top-target.top}px,0)`,opacity},
    {transform:'translate3d(0,0,0)',opacity:expanded?1:0},
   ],{duration,easing:'cubic-bezier(.22,1,.36,1)',fill:'both'});
   flight.animation=animation;
   animation.onfinish=()=>{if(flight.animation!==animation)return;flight.animation=undefined;present(node,expanded);delete node.dataset.moving;animation.cancel();window.dispatchEvent(new Event('lake-chrome-resize'));};
  };
  const measure=()=>{
   if(frame)cancelAnimationFrame(frame);
   frame=0;
   const workspace=shell.querySelector<HTMLElement>('.workspace');
   const view=workspace?.querySelector<HTMLElement>('.session-layout > .session-view');
   if(!workspace||!view)return;
   const dockedPane=shell.classList.contains('has-docked-conversation');
   const collapsed=shell.classList.contains('has-collapsed-sidebar');
   // Sidebar motion translates the island with the conversation viewport.
   // Measure its text and controls when the layout settles.
   if(dockedPane&&(shell.hasAttribute('data-sidebar-sliding')||shell.hasAttribute('data-sidebar-resize-layer'))&&identity.dataset.ready==='true'){
    sidebarCollapsed=collapsed;
    return;
   }
   const bounds=view.getBoundingClientRect(),base=shell.getBoundingClientRect(),workspaceBounds=workspace.getBoundingClientRect();
   const shellStyle=getComputedStyle(shell);
   const composer=view.querySelector('.composer-input')?.getBoundingClientRect();
   const reading=composer??view.querySelector('.timeline-list')?.getBoundingClientRect();
   const frameInset=parseFloat(getComputedStyle(view).getPropertyValue('--conversation-frame-inset'))||0;
   const top=Math.max(shell.closest('html.lake-windows-chrome')?52:12,12+(parseFloat(shellStyle.paddingTop)||0));
   const workspaceStyle=getComputedStyle(workspace);
   const conversationTop=dockedPane?workspaceBounds.top-base.top+parseFloat(workspaceStyle.getPropertyValue('--conversation-island-top')):frameInset?workspaceBounds.top-base.top+parseFloat(workspaceStyle.borderTopWidth)+parseFloat(workspaceStyle.paddingTop)+frameInset:top;
   const paneLeft=dockedPane?workspaceBounds.left+parseFloat(workspaceStyle.getPropertyValue('--conversation-header-inset')):bounds.left+(frameInset?frameInset*2:48);
   const navigation=shell.querySelector<HTMLElement>('.workbench-navigation');
   const toolbar=navigation?.getBoundingClientRect();
   const navigationStart=parseFloat(shellStyle.getPropertyValue('--workbench-navigation-start'))||0;
   const navigationWidth=collapsed&&navigation?
    parseFloat(getComputedStyle(navigation).minInlineSize)+2*parseFloat(shellStyle.getPropertyValue('--workbench-navigation-island-padding')):0;
   const readingLeft=(reading?.left??paneLeft)-base.left;
   const left=collapsed?Math.max(readingLeft,navigationStart):
    toolbar&&toolbar.bottom>base.top+conversationTop?Math.max(readingLeft,toolbar.right-base.left+12):readingLeft;
   const actionsSpace=dockedPane?parseFloat(workspaceStyle.getPropertyValue('--conversation-header-actions-offset'))+12:0;
   const paneRight=dockedPane?bounds.right-actionsSpace:frameInset?bounds.right-frameInset*2:reading?.right??bounds.right-48;
   const right=paneRight-base.left;
   const available=Math.max(1,right-left);
   const identityAvailable=Math.max(1,available-navigationWidth);
   const title=identity.querySelector<HTMLElement>('.crumb-title'),state=identity.querySelector<HTMLElement>('.header-morph-slot.is-visible .header-morph-content');
   const textWidth=(node:HTMLElement|null)=>{
    if(!node)return 0;
    // Text ranges retain the full glyph width through ellipsis. Measuring the
    // rendered font includes its system-font fallback and letter spacing.
    const range=document.createRange();range.selectNodeContents(node);
    return range.getBoundingClientRect().width;
   };
   // Measure intrinsic text/controls, never the width imposed by this island's
   // own container query. Otherwise a compact 114px state expands the island,
   // its natural state shrinks it below 300px, and ResizeObserver oscillates.
   const badge=state?.querySelector<HTMLElement>('.session-state-badge')??null;
   const iconOnly=badge?.hasAttribute('data-icon-only');
   const badgeStyle=badge?getComputedStyle(badge):null;
   // Budget the shared padding token rather than constrained badge geometry.
   const badgePadding=parseFloat(getComputedStyle(identity).getPropertyValue('--island-badge-padding'));
   const badgeLabel=badge?.querySelector<HTMLElement>('.session-state-label')??null;
   const badgeLabelWidth=badgeLabel?textWidth(badgeLabel)+(parseFloat(badgeStyle?.columnGap??'')||0):0;
   const badgeIcon=badge?.querySelector('.session-state-icon');
   // A spinning icon's painted bounds change as it rotates. Use its layout width.
   const badgeIconWidth=badgeIcon?(parseFloat(getComputedStyle(badgeIcon).width)||0):0;
   const badgeWidth=badgeStyle?badgeLabelWidth+badgeIconWidth+2*badgePadding+parseFloat(badgeStyle.borderLeftWidth)+parseFloat(badgeStyle.borderRightWidth):0;
   const disclosure=state?.querySelector<HTMLElement>('.header-inspector-toggle');
   const stateGap=state?parseFloat(getComputedStyle(state).columnGap||'0'):0;
   // The icon-only group's controls are intrinsic, including its leading inset.
   const normalStateWidth=badge&&!iconOnly?badgeWidth+(disclosure?disclosure.getBoundingClientRect().width+stateGap:0):state?.getBoundingClientRect().width??0;
   const titleIcon=title?.previousElementSibling;
   const titleIconWidth=titleIcon ? titleIcon.getBoundingClientRect().width+parseFloat(getComputedStyle(title!.parentElement!).columnGap||'0') : 0;
   const pilotWidth=identity.querySelector('.header-pilot-state.is-visible')?parseFloat(getComputedStyle(identity).getPropertyValue('--pilot-state-width')):0;
   const terminalHeader=terminalIsland.current?.querySelector<HTMLElement>('.terminal-panel-header');
   const terminalLabel=terminalHeader?.querySelector<HTMLElement>('.terminal-island-title');
   // A compact label must not become its own preferred width and stay compact forever.
   if(textMetrics&&terminalLabel)textMetrics.font=getComputedStyle(terminalLabel).font;
   const terminalName=terminalLabel?.querySelector('.terminal-island-title-full')?.textContent??terminalLabel?.textContent??'终端';
   const terminalNameWidth=textMetrics?.measureText(terminalName).width??terminalLabel?.scrollWidth??120;
   const terminalNumber=terminalHeader?.querySelector<HTMLElement>('.terminal-island-number');
   const terminalCount=terminalHeader?.querySelector<HTMLElement>('.terminal-island-count');
   // Pane entrance transforms are visual only, not new landing positions.
   const rail=(pane:HTMLElement|null)=>{
    if(!pane)return;
    let left=0;
    for(let current:HTMLElement|null=pane;current&&current!==shell;current=current.offsetParent as HTMLElement|null)left+=current.offsetLeft;
    return {left,width:pane.offsetWidth};
   };
   // The panel becomes visible after the shared width budget has been applied.
   const terminalPane=open.current.terminal?rail(shell.querySelector<HTMLElement>('.terminal-side-panel.is-open')):undefined;
   const taskTrigger=identity.querySelector<HTMLElement>('.specialist-task-trigger');
   // Use the same stable spacing tokens as CSS. No second status reserve or
   // extra task-button gap: each visible segment contributes exactly once.
   const islandStyle=getComputedStyle(identity);
   const minTitleWidth=parseFloat(islandStyle.getPropertyValue('--island-title-min'));
   const titleWidth=Math.max(minTitleWidth,Math.min(213,(title?textWidth(title):160)+titleIconWidth));
   const inset=parseFloat(islandStyle.getPropertyValue('--island-header-inset'));
   const gap=parseFloat(islandStyle.getPropertyValue('--island-header-gap'));
   const taskControlWidth=taskTrigger?.offsetWidth??0;
   const roster=identity.querySelector<HTMLElement>('.pilot-active-specialists-slot');
   const rosterOpen=roster?.dataset.pilotRosterOpen==='true';
   const rosterPreferred=Number(roster?.dataset.preferredWidth??0);
   const rosterGap=roster?(parseFloat(getComputedStyle(roster).getPropertyValue('--pilot-roster-gap'))||0):0;
   const borders=parseFloat(islandStyle.borderLeftWidth)+parseFloat(islandStyle.borderRightWidth);
   const baseWidth=titleWidth+(pilotWidth||normalStateWidth)+taskControlWidth+2*inset+gap*(taskTrigger?2:1)+borders;
   // Choose the avatar count from the pane budget, independent of the resulting island width.
   // Retiring avatars keep their fitted arrangement while the slot closes.
   const compactRoster=!!roster&&rosterPreferred>0&&identityAvailable<Math.ceil(baseWidth+rosterPreferred+rosterGap);
   const rosterWidth=rosterOpen?(compactRoster?Number(roster.dataset.compactWidth):rosterPreferred)+rosterGap:0;
   const rosterFittedWidth=baseWidth+rosterWidth;
   const compactStatus=rosterOpen&&compactRoster&&badgeLabelWidth>0&&!pilotWidth&&identityAvailable<Math.ceil(rosterFittedWidth);
   identity.toggleAttribute('data-compact-pilot-roster',compactRoster);
   identity.toggleAttribute('data-compact-pilot-status',compactStatus);
   const compactConversationWidth=rosterFittedWidth-(compactStatus?badgeLabelWidth:0);
   const isExpanded=expandedRef.current;
   const conversationWidth=isExpanded?expandedIslandWidth(compactConversationWidth,identityAvailable):compactConversationWidth;
   const layout=workbenchIslandLayout({
    conversation:{left,width:available,inset:0},
    terminal:terminalPane,
    conversationWidth:conversationWidth+navigationWidth,
    inspectorWidth:144,
    terminalWidth:Math.min(320,Math.max(260,terminalNameWidth+(terminalNumber?.offsetWidth??0)+(terminalCount?.offsetWidth??0)+112)),
   });
   const source={...layout.conversation,top:conversationTop};
   // CSS adds the navigation as padding around an unchanged identity width.
   const identityWidth=Math.max(0,source.width-navigationWidth-borders);
   shell.style.setProperty('--pane-rail-bottom',`${Math.max(12,base.bottom-(composer?.top??base.bottom)+12)}px`);
   shell.style.setProperty('--workbench-island-navigation-left',`${source.left}px`);
   shell.style.setProperty('--workbench-island-navigation-top',`${source.top}px`);
   const skipMotion=reduced.matches||document.hidden||document.documentElement.classList.contains('workbench-resizing');
   const toggled=sidebarCollapsed!==collapsed;
   const slide=!dockedPane&&!skipMotion&&(toggled||(sidebarAnimation&&source.left!==previousLeft));
   const fromLeft=slide?identity.getBoundingClientRect().left-base.left:source.left;
   if(dockedPane||slide||skipMotion){sidebarAnimation?.cancel();sidebarAnimation=undefined;}
   sidebarCollapsed=collapsed;previousLeft=source.left;
   const resizeRoster=!isExpanded&&previousExpanded===isExpanded&&!!roster&&roster===previousRoster&&rosterWidth!==previousRosterWidth&&identityWidth!==previousIslandWidth&&!skipMotion&&!slide&&!sidebarAnimation;
   const fromWidth=resizeRoster?parseFloat(islandStyle.width):identityWidth;
   if(identityWidth!==previousIslandWidth||skipMotion||slide||isExpanded||previousExpanded!==isExpanded){rosterAnimation?.cancel();rosterAnimation=undefined;}
   write(identity,{...source,width:identityWidth},dockedPane);
   identity.dataset.ready='true';identity.dataset.present='true';identity.title=title?.textContent??'';
   if(slide&&Math.abs(fromLeft-source.left)>.5){
    const now=performance.now();
    if(toggled)sidebarDeadline=now+parseFloat(islandStyle.transitionDuration)*1000;
    // Retarget from the painted position when the user reverses mid-flight.
    const animation=identity.animate([
     {transform:`translate3d(${fromLeft-source.left}px,0,0)`},{transform:'translate3d(0,0,0)'},
    ],{duration:Math.max(1,sidebarDeadline-now),easing:islandStyle.getPropertyValue('--workbench-sidebar-ease').trim(),fill:'both'});
    sidebarAnimation=animation;
    animation.onfinish=()=>{if(sidebarAnimation!==animation)return;sidebarAnimation=undefined;animation.cancel();window.dispatchEvent(new Event('lake-chrome-resize'));};
   }
   if(resizeRoster&&Math.abs(identityWidth-fromWidth)>.5)rosterAnimation=identity.animate([
    {width:`${fromWidth}px`},{width:`${identityWidth}px`},
   ],{duration:parseFloat(getComputedStyle(roster).transitionDuration)*1000,easing:islandStyle.getPropertyValue('--pilot-roster-ease').trim()});
   previousRoster=roster;previousRosterWidth=rosterWidth;previousIslandWidth=identityWidth;previousExpanded=isExpanded;
   if(terminalIsland.current)move('terminal',terminalIsland.current,layout.terminal?{...layout.terminal,top}:undefined,source,base);
   const candidates=new Set<Element>([shell,...shell.querySelectorAll('.workspace,.session-layout > .session-view,.session-layout > .session-inspector,.terminal-side-panel,.composer-input,.composer-dock,.header-morph-content,.crumb-title,.terminal-island-title')]);
   for(const node of observed)if(!candidates.has(node)){observer.unobserve(node);observed.delete(node);}
   for(const node of candidates)if(!observed.has(node)){observed.add(node);observer.observe(node);}
  };
  const schedule=()=>{if(!frame)frame=requestAnimationFrame(measure);};
  scheduleLayout.current=schedule;
  const observer=new ResizeObserver(schedule);
  const content=new MutationObserver(records=>{
   // Terminal output and message rendering do not move the chrome. Their
   // containing panes/composer already report actual geometry changes above.
   if(records.some(record=>{
    const target=record.target instanceof Element?record.target:record.target.parentElement;
    return !target?.closest('.terminal-session,.conversation,.session-inspector-scroll');
   }))schedule();
  });
  content.observe(shell,{childList:true,subtree:true,characterData:true,attributes:true,attributeFilter:['class','data-pilot-roster-open','data-preferred-width']});
  window.addEventListener('resize',schedule);window.addEventListener('lake-workbench-layout',measure);
  document.addEventListener('visibilitychange',schedule);reduced.addEventListener('change',schedule);measure();
  return()=>{scheduleLayout.current=()=>{};content.disconnect();observer.disconnect();cancelAnimationFrame(frame);window.removeEventListener('resize',schedule);window.removeEventListener('lake-workbench-layout',measure);document.removeEventListener('visibilitychange',schedule);reduced.removeEventListener('change',schedule);rosterAnimation?.cancel();sidebarAnimation?.cancel();for(const flight of Object.values(flights))flight.animation?.cancel();shell.style.removeProperty('--pane-rail-bottom');shell.style.removeProperty('--workbench-island-navigation-left');shell.style.removeProperty('--workbench-island-navigation-top');};
 },[]);
 useLayoutEffect(()=>scheduleLayout.current(),[terminalOpen,expanded]);

 const handleIslandPointerDown=(event:ReactPointerEvent<HTMLDivElement>)=>{
  if(!interactive||event.button!==0)return;
  if(isInteractiveIslandTarget(event.target,conversationIsland.current))return;
  const shell=conversationIsland.current?.closest('.app-shell');
  if(shell?.hasAttribute('data-sidebar-sliding')||document.documentElement.classList.contains('workbench-resizing'))return;
  clearPressTimers();
  pressState.current={active:true,id:event.pointerId,x:event.clientX,y:event.clientY,downAt:performance.now()};
  try{conversationIsland.current?.setPointerCapture(event.pointerId);}catch{}
  setPress('squish');
  pressTimers.current.swell=window.setTimeout(()=>{
   if(pressState.current.active)setPress('swell');
  },ISLAND_PRESS_SWELL_MS);
  pressTimers.current.longPress=window.setTimeout(()=>{
   if(!pressState.current.active)return;
   pressState.current.active=false;
   clearPressTimers();
   setPress('idle');
   setExpanded(current=>!current);
  },ISLAND_LONG_PRESS_MS);
 };
 const handleIslandPointerMove=(event:ReactPointerEvent<HTMLDivElement>)=>{
  const current=pressState.current;
  if(!current.active||current.id!==event.pointerId)return;
  if(Math.hypot(event.clientX-current.x,event.clientY-current.y)>ISLAND_DRAG_CANCEL_PX)cancelPress();
 };
 const handleIslandPointerUp=(event:ReactPointerEvent<HTMLDivElement>)=>{
  const current=pressState.current;
  if(!current.active||current.id!==event.pointerId)return;
  const elapsed=performance.now()-current.downAt;
  cancelPress();
  if(conversationIsland.current?.hasPointerCapture?.(event.pointerId)){
   try{conversationIsland.current.releasePointerCapture(event.pointerId);}catch{}
  }
  if(elapsed<ISLAND_LONG_PRESS_MS)setExpanded(value=>!value);
 };

 return <div ref={root} className="lake-workbench-islands" role="group" aria-label="Lake Island 工作台">
  <div
   ref={conversationIsland}
   className="lake-workbench-island island-conversation"
   data-pilot-island-tone={pilotTone}
   data-island-interactive={interactive?'true':undefined}
   data-island-phase={interactive?(expanded?'expanded':'compact'):undefined}
   data-island-press={interactive?press:undefined}
   onPointerDown={interactive?handleIslandPointerDown:undefined}
   onPointerMove={interactive?handleIslandPointerMove:undefined}
   onPointerUp={interactive?handleIslandPointerUp:undefined}
   onPointerCancel={interactive?cancelPress:undefined}
  >
   <span className="workspace-header-glass" aria-hidden="true"/>
   <span className="island-navigation-divider" aria-hidden="true"/>{activity}{conversation}
   {expandedPanel&&<div className="island-expand-drawer" data-open={expanded} aria-hidden={!expanded} inert={!expanded}>
    <div className="island-expand-inner">
     {expandedPanel({close:()=>setExpanded(false)})}
    </div>
   </div>}
  </div>
  {terminal&&<div ref={terminalIsland} className="lake-workbench-island island-terminal" data-open={terminalOpen} inert={!terminalOpen} aria-hidden={!terminalOpen}><span className="workspace-header-glass" aria-hidden="true"/>{terminal}</div>}
 </div>;
}
