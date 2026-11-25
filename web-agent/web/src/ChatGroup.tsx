import {useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent} from 'react';
import type {ChatGroup, ChatGroupMember, Message, SessionSnapshot, SpecialistChannelInfo} from '../../shared/contracts';
import {TranscriptMessage} from './AIPanel';
import {api, readableError} from './api';
import {CompositionGuard, isSendKey, type SendShortcut} from './composerKeyboard';
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

export function chatGroupRoundOpen(round:NonNullable<SessionSnapshot['chatGroupRounds']>[number]) {
  return round.state==='queued'||round.state==='running';
}

export function ChatGroupMessages({snapshot}:{snapshot:SessionSnapshot}) {
  const rounds=new Map(snapshot.chatGroupRounds?.map(round=>[round.sourceMessageId,round]));
  const replies=new Map<string,Message[]>();
  for(const message of snapshot.messages){
    const source=message.conversation?.sourceMessageId;
    if(message.role!=='assistant'||!source)continue;
    const received=replies.get(source)??[];
    received.push(message);
    replies.set(source,received);
  }
  const inputs=snapshot.messages.filter(message=>message.role==='user');
  if(!inputs.length)return <div className="timeline-empty"><h2>开始群内对话</h2></div>;
  return <div className="ai-transcript chat-group-transcript" data-transcript-mode="conversation">
    {inputs.map(message=>{
      const round=rounds.get(message.id);
      const responding=round?.members.filter(member=>member.state==='running').length??0;
      const queued=round?.members.filter(member=>member.state==='queued').length??0;
      const live=[responding&&`${responding} 位专员正在回应`,queued&&`${queued} 位等待`].filter(Boolean).join(' · ');
      const absent=round?.members.filter(member=>member.reason)??[];
      return <div className="ai-turn" key={message.id}>
        <TranscriptMessage message={message} sessionId={snapshot.session.id}/>
        {replies.get(message.id)?.map(reply=><TranscriptMessage key={reply.id} message={reply} sessionId={snapshot.session.id} roleBreak/>)}
        {(live||absent.length>0)&&<ul className="chat-group-round-status" aria-label="群组回应状态">
          {live&&<li role="status"><Glyph name={responding?'loader':'clock'} size={13} className={responding?'activity-indicator':undefined}/>{live}</li>}
          {absent.map(member=><li key={member.id}><Glyph name="circleAlert" size={13}/>{member.roleName} · {member.reason}</li>)}
        </ul>}
      </div>;
    })}
  </div>;
}

export function ChatGroupComposer({title,draft,onDraft,onSend,disabled,sending,shortcut,error}:{
  title:string;
  draft:string;
  onDraft:(value:string)=>void;
  onSend:(event:FormEvent)=>void;
  disabled:boolean;
  sending:boolean;
  shortcut:SendShortcut;
  error?:string;
}) {
  const input=useRef<HTMLTextAreaElement>(null);
  const composition=useRef(new CompositionGuard());
  useLayoutEffect(()=>{
    if(!input.current)return;
    input.current.style.height='auto';
    input.current.style.height=`${input.current.scrollHeight}px`;
  },[draft]);
  return <form className="composer chat-group-composer" onSubmit={onSend}>
    {error&&<p className="form-error" role="alert">{error}</p>}
    <div className="composer-input chat-group-composer-input">
      <div className="composer-body">
        <textarea ref={input} rows={1} maxLength={4096} aria-label="群消息" placeholder={`发消息到${title}`} value={draft}
          onChange={event=>onDraft(event.target.value)}
          onCompositionStart={()=>composition.current.start()} onCompositionEnd={()=>composition.current.end()}
          onKeyDown={event=>{
            if(composition.current.ignores(event.nativeEvent)||!isSendKey(event.nativeEvent,shortcut))return;
            event.preventDefault();
            event.currentTarget.form?.requestSubmit();
          }}/>
        <button type="submit" className="send-button" aria-label={sending?'正在发送':'发送群消息'}
          disabled={disabled||sending||!draft.trim()} data-send-ready={!!draft.trim()||undefined}>
          <Glyph name={sending?'loader':'up'} size={17} className={sending?'activity-indicator':undefined}/>
        </button>
      </div>
    </div>
  </form>;
}
