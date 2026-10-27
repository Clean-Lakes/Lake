import {useEffect,useId,useRef,useState} from "react";
import type {Project} from "../../shared/contracts";
import {Glyph} from "./Icons";
import {NavigationMenu} from "./NavigationDelete";

export function ProjectSwitcher({projects,value,onChange,embedded=false}:{projects:Project[];value:string;onChange:(id:string)=>void;embedded?:boolean}) {
 const trigger=useRef<HTMLButtonElement>(null);
 const list=useRef<HTMLDivElement>(null),listId=useId();
 const [menu,setMenu]=useState<{x:number;y:number;width:number}|null>(null);
 const selected=projects.find(project=>project.id===value);
 function open(){const rect=trigger.current?.getBoundingClientRect();if(rect)setMenu({x:rect.left,y:rect.bottom+6,width:Math.min(260,Math.max(200,rect.width))});}
 useEffect(()=>{if(embedded&&menu)(list.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')??list.current?.querySelector<HTMLButtonElement>('button'))?.focus({preventScroll:true});},[embedded,!!menu]);
 const button=<button type="button" ref={trigger} className="project-switcher" aria-label={`选择项目：${selected?.name??"项目"}`} aria-haspopup="menu" aria-expanded={!!menu} aria-controls={embedded&&menu?listId:undefined} onClick={()=>menu?setMenu(null):open()} onKeyDown={event=>{if(["ArrowDown","ArrowUp"].includes(event.key)){event.preventDefault();event.stopPropagation();open();}}}><span>{selected?.name??"选择项目"}</span><Glyph name="chevron" size={14}/></button>;
 if(embedded)return <div className="workspace-project-switcher" onKeyDown={event=>{if(menu&&event.key==='Escape'){event.preventDefault();event.stopPropagation();setMenu(null);trigger.current?.focus({preventScroll:true});}}}>{button}{menu&&<div ref={list} id={listId} role="menu" aria-label="切换项目" className="workspace-project-options" onKeyDown={event=>{if(!['ArrowDown','ArrowUp','Home','End'].includes(event.key))return;event.preventDefault();event.stopPropagation();const buttons=[...event.currentTarget.querySelectorAll<HTMLButtonElement>('button')],index=buttons.indexOf(document.activeElement as HTMLButtonElement);buttons[event.key==='Home'?0:event.key==='End'?buttons.length-1:(index+(event.key==='ArrowUp'?-1:1)+buttons.length)%buttons.length]?.focus();}}>{projects.map(project=><button key={project.id} type="button" role="menuitemradio" aria-checked={project.id===value} title={project.name} onClick={()=>{setMenu(null);if(project.id!==value)onChange(project.id);else trigger.current?.focus({preventScroll:true});}}><span>{project.name}</span>{project.id===value&&<Glyph name="check" size={14}/>}</button>)}</div>}</div>;
 return <>{button}{menu&&<NavigationMenu title="切换项目" className="project-selector-menu" anchor={trigger} width={menu.width} x={menu.x} y={menu.y} onClose={()=>setMenu(null)} actions={projects.map(project=>({label:project.name,checked:project.id===value,run:()=>{if(project.id!==value)onChange(project.id);trigger.current?.focus();}}))}/>}</>;
}
