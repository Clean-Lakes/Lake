import {useId, useRef, useState, type FormEvent, type RefObject} from 'react';
import type {ChatGroup, ChatGroupMember, SpecialistChannelInfo} from '../../shared/contracts';
import {api, readableError} from './api';
import {Glyph} from './Icons';
import {SuperRoleAvatar} from './SuperRoleAvatar';
import {WorkbenchModalDialog} from './WorkbenchModalDialog';

export function ChatGroupAvatars({members,compact=false}:{members:readonly ChatGroupMember[];compact?:boolean}) {
  return <span className="chat-group-avatars" aria-hidden="true">
    {members.length ? members.slice(0,compact?2:3).map(member =>
      <SuperRoleAvatar key={member.roleId} roleId={member.roleId} name={member.roleName} avatarId={member.avatarId} size={compact?14:16} motion="still"/>
    ) : <Glyph name="lakeSpecialists" size={18}/>}
  </span>;
}

export function ChatGroupNavigation({groups,selectedId,onOpen}:{
  groups:readonly ChatGroup[];
  selectedId:string|null;
  onOpen:(sessionId:string)=>void;
}) {
  return <section className="chat-group-navigation" aria-label="群组">
    <div className="chat-group-navigation-heading">
      <h2>群组</h2>
    </div>
    {groups.map(group=><button key={group.sessionId} type="button" className="nav-row chat-group-nav-row"
      aria-current={selectedId===group.sessionId?'page':undefined} onClick={()=>onOpen(group.sessionId)}>
      <ChatGroupAvatars members={group.members} compact/>
      <span className="nav-row-text">
        <strong title={group.title}>{group.title}</strong>
        <small>{group.latest ? [group.latest.author,group.latest.text].filter(Boolean).join('：') : `${group.members.length} 位专员`}</small>
      </span>
    </button>)}
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
          <button type="button" className="button secondary" onClick={()=>requestClose()} disabled={busy}>取消</button>
          <button type="submit" className="button primary" disabled={!ready}>{busy?'正在创建…':'创建群组'}</button>
        </footer>
      </form>
    </>}
  </WorkbenchModalDialog>;
}
