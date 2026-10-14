import {useRef,useState} from "react";
import type {Project} from "../../shared/contracts";
import {Glyph} from "./Icons";
import {NavigationMenu} from "./NavigationDelete";

export function ProjectSwitcher({projects,value,onChange}:{projects:Project[];value:string;onChange:(id:string)=>void}) {
 const trigger=useRef<HTMLButtonElement>(null);
 const [menu,setMenu]=useState<{x:number;y:number;width:number}|null>(null);
 const selected=projects.find(project=>project.id===value);
 function open(){const rect=trigger.current?.getBoundingClientRect();if(rect)setMenu({x:rect.left,y:rect.bottom+6,width:Math.min(260,Math.max(200,rect.width))});}
 return <><button type="button" ref={trigger} className="project-switcher" aria-label={`选择项目：${selected?.name??"项目"}`} aria-haspopup="menu" aria-expanded={!!menu} onClick={()=>menu?setMenu(null):open()} onKeyDown={event=>{if(["ArrowDown","ArrowUp"].includes(event.key)){event.preventDefault();open();}}}><Glyph name="folder" size={16}/><span>{selected?.name??"选择项目"}</span><Glyph name="chevron" size={14}/></button>{menu&&<NavigationMenu title="切换项目" className="project-selector-menu" anchor={trigger} width={menu.width} x={menu.x} y={menu.y} onClose={()=>setMenu(null)} actions={projects.map(project=>({label:project.name,checked:project.id===value,run:()=>{if(project.id!==value)onChange(project.id);trigger.current?.focus();}}))}/>}</>;
}
