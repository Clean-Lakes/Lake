import {useEffect, useId, useRef, useState, type FormEvent} from 'react';
import type {ChatGroup, ChatGroupMember, SpecialistChannelInfo} from '../../shared/contracts';
import {api, readableError} from './api';
import {Glyph} from './Icons';
import {SuperRoleAvatar} from './SuperRoleAvatar';

export function ChatGroupAvatars({members,compact=false}:{members:readonly ChatGroupMember[];compact?:boolean}) {
  return <span className="chat-group-avatars" aria-hidden="true">
    {members.length ? members.slice(0,compact?2:3).map(member =>
      <SuperRoleAvatar key={member.roleId} roleId={member.roleId} name={member.roleName} avatarId={member.avatarId} size={compact?14:16} motion="still"/>
    ) : <Glyph name="lakeSpecialists" size={18}/>}
  </span>;
}

export function ChatGroupNavigation({projectId, groups, channels, selectedId, disabled, onOpen, onCreated}:{
  projectId:string;
  groups:readonly ChatGroup[];
  channels:readonly SpecialistChannelInfo[];
  selectedId:string|null;
  disabled:boolean;
  onOpen:(sessionId:string)=>void;
  onCreated:(group:ChatGroup)=>Promise<void>;
}) {
  const [creating, setCreating] = useState(false);
  return <section className="chat-group-navigation" aria-label="群组">
    <div className="chat-group-navigation-heading">
      <h2>群组</h2>
      <button type="button" className="icon-button" aria-label="新建群组" title="新建群组" disabled={disabled} onClick={()=>setCreating(true)}>
        <Glyph name="plus" size={16}/>
      </button>
    </div>
    {groups.map(group=><button key={group.sessionId} type="button" className="nav-row chat-group-nav-row"
      aria-current={selectedId===group.sessionId?'page':undefined} onClick={()=>onOpen(group.sessionId)}>
      <ChatGroupAvatars members={group.members} compact/>
      <span className="nav-row-text">
        <strong title={group.title}>{group.title}</strong>
        <small>{group.latest ? [group.latest.author,group.latest.text].filter(Boolean).join('：') : `${group.members.length} 位专员`}</small>
      </span>
    </button>)}
    {creating&&<CreateChatGroup projectId={projectId} channels={channels} disabled={disabled}
      onCreated={onCreated} onClose={()=>setCreating(false)}/>}
  </section>;
}

function CreateChatGroup({projectId, channels, disabled, onCreated, onClose}:{
  projectId:string;
  channels:readonly SpecialistChannelInfo[];
  disabled:boolean;
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
    const previous=document.activeElement;
    const node=dialog.current;
    node?.showModal();
    input.current?.focus({preventScroll:true});
    return ()=>{
      node?.close();
      if(previous instanceof HTMLElement&&previous.isConnected)previous.focus({preventScroll:true});
    };
  },[]);

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
