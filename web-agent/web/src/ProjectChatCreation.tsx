import {useId,useRef,useState} from 'react';
import type {ChatGroup,SpecialistChannelInfo} from '../../shared/contracts';
import {CreateChatGroup} from './ChatGroup';
import {Glyph} from './Icons';
import {NavigationMenu} from './NavigationDelete';
import {SpecialistCreate} from './SpecialistCreate';

const menuWidth=168;

export function ProjectChatCreation({projectId,channels,compact,disabled,groupsReady,onSpecialistCreated,onGroupCreated}:{
 projectId:string;
 channels:readonly SpecialistChannelInfo[];
 compact:boolean;
 disabled:boolean;
 groupsReady:boolean;
 onSpecialistCreated:(channel:SpecialistChannelInfo)=>void;
 onGroupCreated:(group:ChatGroup)=>Promise<void>;
}) {
 const id=useId(),trigger=useRef<HTMLButtonElement>(null);
 const [menu,setMenu]=useState<{x:number;y:number}|null>(null);
 const lastMenu=useRef<{x:number;y:number}|null>(null);
 if(menu)lastMenu.current=menu;
 const renderedMenu=menu??lastMenu.current;
 const [form,setForm]=useState<'specialist'|'group'|null>(null);
 const closeForm=()=>setForm(null);

 return <>
  <button ref={trigger} type="button" className={`${compact?'sidebar-rail-button':'icon-button'} sidebar-create-trigger`}
    aria-label="新建" title="新建专员或群组" aria-haspopup="menu" aria-expanded={!!menu} aria-controls={menu?id:undefined}
    disabled={disabled} onClick={event=>{
      const bounds=event.currentTarget.getBoundingClientRect();
      const headerLeft=event.currentTarget.closest('.sidebar-brand-row')?.getBoundingClientRect().left??0;
      setMenu(current=>current?null:{x:compact?bounds.right+6:Math.max(headerLeft,bounds.right-menuWidth),y:compact?bounds.top:bounds.bottom+6});
    }}><Glyph name="plus" size={18}/></button>
  {renderedMenu&&<NavigationMenu id={id} open={!!menu} title="项目新建" className="project-chat-creation-menu" width={menuWidth} x={renderedMenu.x} y={renderedMenu.y}
    anchor={trigger} onClose={()=>setMenu(null)} actions={[
    {label:'新建专员',icon:'lakeSpecialists',disabled,run:()=>setForm('specialist')},
    {label:'新建群组',icon:'users',disabled:disabled||!groupsReady,run:()=>setForm('group')},
  ]}/>}
  {form==='specialist'&&<SpecialistCreate projectId={projectId} disabled={disabled} returnFocus={trigger} onCreated={onSpecialistCreated} onClose={closeForm}/>}
  {form==='group'&&<CreateChatGroup projectId={projectId} channels={channels} disabled={disabled||!groupsReady} returnFocus={trigger}
    onCreated={onGroupCreated} onClose={closeForm}/>}
 </>;
}
