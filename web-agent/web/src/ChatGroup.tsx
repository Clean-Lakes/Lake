import {useEffect, useId, useRef, useState, type Dispatch, type FormEvent, type RefObject, type SetStateAction} from 'react';
import type {ChatGroup, ChatGroupMember, SpecialistChannelInfo, SuperWorkspace, WorkSession} from '../../shared/contracts';
import {ActivityDots} from './ActivityIndicator';
import {api, readableError} from './api';
import {chatGroupActivity} from './chatGroupActivity';
import {Glyph} from './Icons';
import {NavigationMenu} from './NavigationDelete';
import type {ConversationAvatarActivity} from './superAgentPresentation';
import {SuperRoleAvatar} from './SuperRoleAvatar';
import {WorkbenchModalDialog} from './WorkbenchModalDialog';

export function ChatGroupAvatars({members,compact=false,activeRoleIds,waitingRoleIds}:{
  members:readonly ChatGroupMember[];
  compact?:boolean;
  activeRoleIds?:ReadonlySet<string>;
  waitingRoleIds?:ReadonlySet<string>;
}) {
  const limit=compact?3:4;
  const shown=members.slice(0,limit);
  const remaining=members.length-shown.length;
  const size=compact?16:17;
  return <span className="chat-group-avatars" data-multiple={members.length>1||undefined} aria-hidden="true">
    {shown.length ? <>
      {shown.map(member => {
        const activity=waitingRoleIds?.has(member.roleId)?'waiting':activeRoleIds?.has(member.roleId)?'running':undefined;
        return <span className="chat-group-avatar-chip" key={member.roleId} data-activity={activity}>
          <SuperRoleAvatar roleId={member.roleId} name={member.roleName} avatarId={member.avatarId} size={size} motion={activity==='running'?'working':'still'}/>
        </span>;
      })}
      {remaining>0 && <span className="chat-group-avatar-overflow">+{remaining}</span>}
    </> : <Glyph name="lakeSpecialists" size={18}/>}
  </span>;
}

export function ChatGroupNavigation({groups,selectedId,workspace,sessions,activity,connected=true,onOpen,onUpdated,createGroup}:{
  groups:readonly ChatGroup[];
  selectedId:string|null;
  workspace?:SuperWorkspace|null;
  sessions?:readonly WorkSession[];
  activity?:ConversationAvatarActivity;
  connected?:boolean;
  onOpen:(sessionId:string)=>void;
  onUpdated?:(group:ChatGroup)=>void;
  createGroup?:{
    projectId:string;
    channels:readonly SpecialistChannelInfo[];
    disabled:boolean;
    onCreated:(group:ChatGroup)=>Promise<void>;
  };
}) {
  const [creating,setCreating]=useState(false);
  const [menuId,setMenuId]=useState<string|null>(null);
  const [editing,setEditing]=useState<{group:ChatGroup;section:'members'|'details'}|null>(null);
  const createButton=useRef<HTMLButtonElement>(null);
  const menuAnchor=useRef<HTMLButtonElement>(null);
  const lastMenu=useRef<ChatGroup>(undefined);
  const canManage=!!createGroup&&!createGroup.disabled&&!!onUpdated;
  const menuGroup=groups.find(group=>group.sessionId===menuId);
  if(menuGroup)lastMenu.current=menuGroup;
  const renderedMenu=menuGroup??lastMenu.current;
  useEffect(()=>{setCreating(false);setMenuId(null);setEditing(null);lastMenu.current=undefined;},[createGroup?.projectId]);
  useEffect(()=>{if(!canManage)setMenuId(null);},[canManage]);

  function showMenu(group:ChatGroup,button:HTMLButtonElement){
    menuAnchor.current=button;
    setMenuId(group.sessionId);
  }

  return <section className="chat-group-navigation" aria-label="群组">
    <div className="chat-group-navigation-heading">
      <h2>群组</h2>
      {createGroup&&<button ref={createButton} type="button" className="icon-button chat-group-create-trigger"
        aria-label="新建群组" title="新建群组" disabled={createGroup.disabled}
        onClick={()=>setCreating(true)}><Glyph name="plus" size={15}/></button>}
    </div>
    {groups.map(group=>{
      const groupState=chatGroupActivity(group,workspace,sessions,activity,connected);
      return <button key={group.sessionId} type="button" className="nav-row chat-group-nav-row"
        aria-current={selectedId===group.sessionId?'page':undefined}
        data-activity={groupState.state!=='idle'?groupState.state:undefined}
        aria-haspopup={canManage?'menu':undefined}
        aria-expanded={canManage?menuId===group.sessionId:undefined}
        aria-keyshortcuts={canManage?'Shift+F10':undefined}
        onContextMenu={canManage?event=>{
          event.preventDefault();
          event.stopPropagation();
          showMenu(group,event.currentTarget);
        }:undefined}
        onKeyDown={canManage?event=>{
          if(event.key==='ContextMenu'||event.shiftKey&&event.key==='F10'){
            event.preventDefault();
            showMenu(group,event.currentTarget);
          }
        }:undefined}
        onClick={()=>{setMenuId(null);onOpen(group.sessionId);}}>
        <ChatGroupAvatars members={group.members} compact activeRoleIds={groupState.workingRoleIds} waitingRoleIds={groupState.waitingRoleIds}/>
        <span className="nav-row-text">
          <span className="chat-group-row-head">
            <strong title={group.title}>{group.title}</strong>
            {groupState.state!=='idle'&&<span className="pilot-worker-status">
              {groupState.state==='waiting'
                ?<span className="pilot-worker-confirmation">需确认</span>
                :<span className="pilot-worker-running" role="img" aria-label="处理中"><ActivityDots className="activity-indicator"/></span>}
            </span>}
          </span>
          <small>{groupState.detail??(group.latest?[group.latest.author,group.latest.text].filter(Boolean).join('：'):`${group.members.length} 位专员`)}</small>
        </span>
      </button>;
    })}
    {renderedMenu&&<NavigationMenu key={renderedMenu.sessionId} title={renderedMenu.title} placement="beside" anchor={menuAnchor}
      open={canManage&&!!menuGroup} onClose={()=>setMenuId(null)} actions={[
        {label:'成员编辑',icon:'users',run:()=>setEditing({group:renderedMenu,section:'members'})},
        {label:'基础信息',icon:'edit',run:()=>setEditing({group:renderedMenu,section:'details'})},
      ]}/>}
    {editing&&createGroup&&onUpdated&&<EditChatGroup {...editing} channels={createGroup.channels} disabled={createGroup.disabled}
      returnFocus={menuAnchor} onUpdated={onUpdated} onClose={()=>setEditing(null)}/>}
    {creating&&createGroup&&<CreateChatGroup projectId={createGroup.projectId} channels={createGroup.channels}
      disabled={createGroup.disabled} returnFocus={createButton} onCreated={createGroup.onCreated}
      onClose={()=>setCreating(false)}/>}
  </section>;
}

function ChatGroupMemberPicker({channels,selected,setSelected,disabled,firstMember}:{
  channels:readonly SpecialistChannelInfo[];
  selected:ReadonlySet<string>;
  setSelected:Dispatch<SetStateAction<ReadonlySet<string>>>;
  disabled:boolean;
  firstMember?:RefObject<HTMLInputElement|null>;
}) {
  const selectedCount=channels.filter(channel=>selected.has(channel.roleId)).length;
  return <fieldset className="chat-group-member-picker" disabled={disabled}>
    <legend>选择至少两位专员</legend>
    {channels.length ? <div className="chat-group-member-list">
      {channels.map((channel,index)=><label key={channel.roleId}>
        <input ref={index===0?firstMember:undefined} type="checkbox" checked={selected.has(channel.roleId)}
          disabled={selectedCount>=64&&!selected.has(channel.roleId)} onChange={event=>{
            const checked=event.target.checked;
            setSelected(current=>{
              const next=new Set(current);
              if(checked)next.add(channel.roleId);else next.delete(channel.roleId);
              return next;
            });
          }}/>
        <SuperRoleAvatar roleId={channel.roleId} name={channel.roleName} avatarId={channel.avatarId} motion="still"/>
        <span>{channel.roleName}</span>
      </label>)}
    </div> : <p>当前项目还没有可选专员。</p>}
  </fieldset>;
}

function EditChatGroup({group,section,channels,disabled,returnFocus,onUpdated,onClose}:{
  group:ChatGroup;
  section:'members'|'details';
  channels:readonly SpecialistChannelInfo[];
  disabled:boolean;
  returnFocus:RefObject<HTMLButtonElement|null>;
  onUpdated:(group:ChatGroup)=>void;
  onClose:()=>void;
}) {
  const heading=useId();
  const nameInput=useRef<HTMLInputElement>(null),firstMember=useRef<HTMLInputElement>(null);
  const sending=useRef(false);
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  const [title,setTitle]=useState(group.title),[description,setDescription]=useState(group.description??'');
  const [selected,setSelected]=useState<ReadonlySet<string>>(()=>new Set(group.members.filter(member=>!member.unavailable).map(member=>member.roleId)));
  const memberEditor=section==='members';
  const label=memberEditor?'成员编辑':'基础信息';
  const available=new Set(channels.map(channel=>channel.roleId));
  const currentIds=group.members.map(member=>member.roleId);
  const roleIds=[...new Set([...currentIds,...available])].filter(id=>available.has(id)&&selected.has(id));
  const ready=!disabled&&!busy&&(memberEditor
    ? roleIds.length>=2&&roleIds.length<=64&&(roleIds.length!==currentIds.length||roleIds.some((id,index)=>id!==currentIds[index]))
    : !!title.trim()&&(title.trim()!==group.title||description.trim()!==(group.description??'')));

  async function save(event:FormEvent,closeDialog:(force?:boolean)=>void){
    event.preventDefault();
    if(!ready||sending.current)return;
    sending.current=true;
    setBusy(true);
    setError('');
    try{
      const updated=await api.updateChatGroup(group.projectId,group.sessionId,{
        expectedRevision:group.revision??1,
        ...(memberEditor?{roleIds}:{title:title.trim(),description:description.trim()}),
      });
      onUpdated(updated);
      closeDialog(true);
    }catch(reason){
      setError(readableError(reason));
    }finally{
      sending.current=false;
      setBusy(false);
    }
  }

  return <WorkbenchModalDialog className="chat-group-edit-dialog" labelledBy={heading} busy={busy}
    returnFocus={returnFocus} initialFocus={memberEditor?firstMember:nameInput} onClose={onClose}>
    {requestClose=><>
      <header className="workbench-dialog-header">
        <div><h2 id={heading}>{label}</h2>{memberEditor&&<p>{group.title}</p>}</div>
        <button type="button" className="icon-button" aria-label={`关闭${label}`} disabled={busy} onClick={()=>requestClose()}><Glyph name="close" size={16}/></button>
      </header>
      <form className="workbench-dialog-form" onSubmit={event=>void save(event,requestClose)}>
        <div className="workbench-dialog-body">
          {memberEditor ? <ChatGroupMemberPicker channels={channels} selected={selected} setSelected={setSelected} disabled={busy} firstMember={firstMember}/> : <>
            <label className="field-label">群名<input ref={nameInput} maxLength={80} value={title} disabled={busy} onChange={event=>setTitle(event.target.value)}/></label>
            <label className="field-label">群简介<textarea rows={3} maxLength={240} value={description} disabled={busy} onChange={event=>setDescription(event.target.value)}/></label>
          </>}
          {error&&<p className="form-error" role="alert">{error}</p>}
        </div>
        <footer className="workbench-dialog-footer">
          <button type="button" className="button secondary" disabled={busy} onClick={()=>requestClose()}>取消</button>
          <button type="submit" className="button primary" disabled={!ready}>{busy?'正在保存…':'保存'}</button>
        </footer>
      </form>
    </>}
  </WorkbenchModalDialog>;
}

export function CreateChatGroup({projectId,channels,disabled,returnFocus,onCreated,onClose}:{
  projectId:string;
  channels:readonly SpecialistChannelInfo[];
  disabled:boolean;
  returnFocus:RefObject<HTMLButtonElement|null>;
  onCreated:(group:ChatGroup)=>Promise<void>;
  onClose:()=>void;
}) {
  const id=useId();
  const input=useRef<HTMLInputElement>(null);
  const request=useRef<{signature:string;id:string}>(undefined);
  const sending=useRef(false);
  const [title,setTitle]=useState('');
  const [selected,setSelected]=useState<ReadonlySet<string>>(()=>new Set());
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const roleIds=channels.flatMap(channel=>selected.has(channel.roleId)?[channel.roleId]:[]);
  const ready=!disabled&&!busy&&title.trim()&&roleIds.length>=2&&roleIds.length<=64;

  async function create(event:FormEvent,closeDialog:(force?:boolean)=>void) {
    event.preventDefault();
    if(!ready||sending.current)return;
    sending.current=true;
    setBusy(true);
    setError('');
    const name=title.trim();
    const signature=JSON.stringify([name,roleIds]);
    if(request.current?.signature!==signature)request.current={signature,id:crypto.randomUUID()};
    let created=false;
    try {
      const group=await api.createChatGroup(projectId,{title:name,roleIds,requestId:request.current.id});
      await onCreated(group);
      created=true;
    }catch(reason){
      setError(readableError(reason));
    }finally{
      sending.current=false;
      setBusy(false);
    }
    if(created)closeDialog(true);
  }

  return <WorkbenchModalDialog className="chat-group-create-dialog" labelledBy={id} busy={busy}
    returnFocus={returnFocus} initialFocus={input} onClose={onClose}>
    {requestClose=><>
      <header className="workbench-dialog-header">
        <h2 id={id}>新建群组</h2>
        <button type="button" className="icon-button" aria-label="关闭新建群组" disabled={busy} onClick={()=>requestClose()}><Glyph name="close" size={16}/></button>
      </header>
      <form className="workbench-dialog-form" onSubmit={event=>void create(event,requestClose)}>
        <div className="workbench-dialog-body">
          <label className="field-label">群名<input ref={input} maxLength={80} placeholder="例如：运维协作群" disabled={busy}
            value={title} onChange={event=>setTitle(event.target.value)}/></label>
          <ChatGroupMemberPicker channels={channels} selected={selected} setSelected={setSelected} disabled={busy}/>
          {error&&<p className="form-error" role="alert">{error}</p>}
        </div>
        <footer className="workbench-dialog-footer">
          <button type="button" className="button secondary" onClick={()=>requestClose()} disabled={busy}>取消</button>
          <button type="submit" className="button primary" disabled={!ready}>{busy?'正在创建…':'创建群组'}</button>
        </footer>
      </form>
    </>}
  </WorkbenchModalDialog>;
}
