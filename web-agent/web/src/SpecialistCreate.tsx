import {useId,useRef,useState,type FormEvent,type RefObject} from 'react';
import type {SpecialistChannelInfo} from '../../shared/contracts';
import {isLakeAvatarName,lakeAvatarGroups,type LakeAvatarName} from '../../shared/specialist-avatars';
import {api,readableError} from './api';
import {AppSelect} from './AppSelect';
import {Glyph} from './Icons';
import {SuperRoleAvatar} from './SuperRoleAvatar';
import {WorkbenchModalDialog} from './WorkbenchModalDialog';

const animalGroups=lakeAvatarGroups.filter(group=>group.family!=='lotus');

export function SpecialistCreate({projectId,disabled,onCreated,onClose,returnFocus}:{
 projectId:string;
 disabled:boolean;
 onCreated:(channel:SpecialistChannelInfo)=>void;
 onClose:()=>void;
 returnFocus:RefObject<HTMLButtonElement|null>;
}) {
 const titleId=useId();
 const nameInput=useRef<HTMLInputElement>(null);
 const request=useRef<{signature:string;id:string}|null>(null);
 const saving=useRef(false);
 const [name,setName]=useState('');
 const [avatarId,setAvatarId]=useState<LakeAvatarName|''>('');
 const [duties,setDuties]=useState('');
 const [busy,setBusy]=useState(false);
 const [error,setError]=useState('');
 const ready=!!(name.trim()&&duties.trim()&&avatarId)&&!disabled&&!busy;

 async function save(event:FormEvent<HTMLFormElement>,closeDialog:(force?:boolean)=>void) {
  event.preventDefault();
  if(!ready||!avatarId||saving.current)return;
  const profile={name:name.trim(),duties:duties.trim(),avatarId};
  const signature=JSON.stringify(profile);
  if(request.current?.signature!==signature)request.current={signature,id:crypto.randomUUID()};
  saving.current=true;
  setBusy(true);
  setError('');
  let created=false;
  try {
   const channel=await api.createSpecialist(projectId,{...profile,requestId:request.current.id});
   onCreated(channel);
   created=true;
  }catch(reason){
   setError(readableError(reason));
  }finally{
   saving.current=false;
   setBusy(false);
  }
  if(created)closeDialog(true);
 }

 return <WorkbenchModalDialog className="specialist-create-dialog" labelledBy={titleId} busy={busy}
  returnFocus={returnFocus} initialFocus={nameInput} onClose={onClose}>
  {requestClose=><>
   <header className="workbench-dialog-header">
    <h2 id={titleId}>新建专员</h2>
    <button type="button" className="icon-button" aria-label="关闭新建专员" disabled={busy} onClick={()=>requestClose()}><Glyph name="close" size={16}/></button>
   </header>
   <form className="workbench-dialog-form" onSubmit={event=>void save(event,requestClose)}>
    <div className="workbench-dialog-body">
     <label className="field-label">动物头像
      <AppSelect value={avatarId} label="动物头像" required disabled={busy}
       icon={avatarId?<SuperRoleAvatar avatarId={avatarId} size={22}/>:undefined}
       renderOption={option=><>{isLakeAvatarName(option.value)&&<SuperRoleAvatar avatarId={option.value} size={22}/>}<span>{option.label}</span></>}
       onChange={event=>{const value=event.target.value;if(isLakeAvatarName(value))setAvatarId(value);}}>
       <option value="" disabled>选择动物</option>
       {animalGroups.map(group=><optgroup key={group.family} label={group.label}>
        {group.avatars.map(avatar=><option key={avatar.id} value={avatar.id}>{avatar.name}</option>)}
       </optgroup>)}
      </AppSelect>
     </label>
     <label className="field-label">名称
      <input ref={nameInput} required maxLength={128} disabled={busy} value={name} onChange={event=>setName(event.target.value)}/>
     </label>
     <label className="field-label">角色描述
      <textarea required maxLength={4096} rows={4} disabled={busy} value={duties} onChange={event=>setDuties(event.target.value)}/>
     </label>
     {error&&<p className="form-error" role="alert">{error}</p>}
    </div>
    <footer className="workbench-dialog-footer">
     <button type="button" className="button secondary" disabled={busy} onClick={()=>requestClose()}>取消</button>
     <button type="submit" className="button primary" disabled={!ready}>{busy?'正在创建…':'创建专员'}</button>
    </footer>
   </form>
  </>}
 </WorkbenchModalDialog>;
}
