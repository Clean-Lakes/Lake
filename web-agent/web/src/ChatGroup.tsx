import {useEffect, useId, useRef, useState, type FormEvent, type RefObject} from 'react';
import type {ChatGroup, ChatGroupMember, SpecialistChannelInfo, SuperWorkspace, WorkSession} from '../../shared/contracts';
import {ActivityDots} from './ActivityIndicator';
import {api, readableError} from './api';
import {chatGroupActivity} from './chatGroupActivity';
import {Glyph} from './Icons';
import type {ConversationAvatarActivity} from './superAgentPresentation';
import {SuperRoleAvatar} from './SuperRoleAvatar';

export function ChatGroupAvatars({members,compact=false,activeRoleIds,waitingRoleIds}:{
  members:readonly ChatGroupMember[];
  compact?:boolean;
  activeRoleIds?:ReadonlySet<string>;
  waitingRoleIds?:ReadonlySet<string>;
}) {
  return <span className="chat-group-avatars" aria-hidden="true">
    {members.length ? members.slice(0,compact?2:3).map(member => {
      const activity = waitingRoleIds?.has(member.roleId) ? 'waiting' : activeRoleIds?.has(member.roleId) ? 'running' : undefined;
      return <span className="chat-group-avatar-item" key={member.roleId} data-activity={activity}>
        <SuperRoleAvatar roleId={member.roleId} name={member.roleName} avatarId={member.avatarId} size={compact?14:16} motion={activity==='running'?'working':'still'}/>
      </span>;
    }) : <Glyph name="lakeSpecialists" size={18}/>}
  </span>;
}

export function ChatGroupNavigation({groups,selectedId,workspace,sessions,activity,connected=true,onOpen}:{
  groups:readonly ChatGroup[];
  selectedId:string|null;
  workspace?:SuperWorkspace|null;
  sessions?:readonly WorkSession[];
  activity?:ConversationAvatarActivity;
  connected?:boolean;
  onOpen:(sessionId:string)=>void;
}) {
  return <section className="chat-group-navigation" aria-label="群组">
    <div className="chat-group-navigation-heading">
      <h2>群组</h2>
    </div>
    {groups.map(group=>{
      const groupState=chatGroupActivity(group,workspace,sessions,activity,connected);
      return <button key={group.sessionId} type="button" className="nav-row chat-group-nav-row"
        aria-current={selectedId===group.sessionId?'page':undefined}
        data-activity={groupState.state!=='idle'?groupState.state:undefined}
        onClick={()=>onOpen(group.sessionId)}>
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
  </section>;
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
  const dialog=useRef<HTMLDialogElement>(null);
  const input=useRef<HTMLInputElement>(null);
  const request=useRef<{signature:string;id:string}>(undefined);
  const sending=useRef(false);
  const [title,setTitle]=useState('');
  const [selected,setSelected]=useState<ReadonlySet<string>>(()=>new Set());
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const roleIds=channels.flatMap(channel=>selected.has(channel.roleId)?[channel.roleId]:[]);
  const ready=!disabled&&!busy&&title.trim()&&roleIds.length>=2&&roleIds.length<=64;
  useEffect(()=>{
    const previous=returnFocus.current;
    const node=dialog.current;
    node?.showModal();
    input.current?.focus({preventScroll:true});
    return ()=>{
      node?.close();
      if(previous?.isConnected)previous.focus({preventScroll:true});
    };
  },[returnFocus]);

  async function create(event:FormEvent) {
    event.preventDefault();
    if(!ready||sending.current)return;
    sending.current=true;
    setBusy(true);
    setError('');
    const name=title.trim();
    const signature=JSON.stringify([name,roleIds]);
    if(request.current?.signature!==signature)request.current={signature,id:crypto.randomUUID()};
    try {
      const group=await api.createChatGroup(projectId,{title:name,roleIds,requestId:request.current.id});
      await onCreated(group);
      onClose();
    }catch(reason){
      setError(readableError(reason));
    }finally{
      sending.current=false;
      setBusy(false);
    }
  }

  return <dialog ref={dialog} className="modal workbench-dialog chat-group-create-dialog" aria-labelledby={id}
    onCancel={event=>{event.preventDefault();if(!busy)onClose();}}>
    <header className="workbench-dialog-header">
      <h2 id={id}>新建群组</h2>
      <button type="button" className="icon-button" aria-label="关闭新建群组" disabled={busy} onClick={onClose}><Glyph name="close" size={16}/></button>
    </header>
    <form className="workbench-dialog-form" onSubmit={create}>
      <div className="workbench-dialog-body">
        <label className="field-label">群名<input ref={input} maxLength={80} placeholder="例如：运维协作群" disabled={busy}
          value={title} onChange={event=>setTitle(event.target.value)}/></label>
        <fieldset className="chat-group-member-picker" disabled={busy}>
          <legend>选择至少两位专员</legend>
          {channels.length ? <div className="chat-group-member-list">
            {channels.map(channel=><label key={channel.roleId}>
              <input type="checkbox" checked={selected.has(channel.roleId)} disabled={roleIds.length>=64&&!selected.has(channel.roleId)}
                onChange={event=>{
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
        </fieldset>
        {error&&<p className="form-error" role="alert">{error}</p>}
      </div>
      <footer className="workbench-dialog-footer">
        <button type="button" className="button secondary" onClick={onClose} disabled={busy}>取消</button>
        <button type="submit" className="button primary" disabled={!ready}>{busy?'正在创建…':'创建群组'}</button>
      </footer>
    </form>
  </dialog>;
}
