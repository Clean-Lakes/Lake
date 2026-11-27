import {useId,useRef,useState,type FormEvent,type RefObject} from 'react';
import type {SpecialistChannelInfo} from '../../shared/contracts';
import {isLakeAvatarName,lakeAvatarGroups,type LakeAvatarName} from '../../shared/specialist-avatars';
import {api,readableError} from './api';
import {AppSelect} from './AppSelect';
import {Glyph} from './Icons';
import {SuperRoleAvatar} from './SuperRoleAvatar';
import {WorkbenchModalDialog} from './WorkbenchModalDialog';

const animalGroups=lakeAvatarGroups.filter(group=>group.family!=='lotus');

type DialogProps={
 disabled:boolean;
 onClose:()=>void;
 returnFocus:RefObject<HTMLButtonElement|null>;
};
type SaveProfile=(channel:SpecialistChannelInfo)=>void;

export function SpecialistCreate({onCreated,...props}:DialogProps&{projectId:string;onCreated:SaveProfile}) {
 return <SpecialistProfileDialog {...props} onSaved={onCreated}/>;
}

export function SpecialistEdit({channel,...props}:DialogProps&{channel:SpecialistChannelInfo;onSaved:SaveProfile}) {
 return <SpecialistProfileDialog {...props} projectId={channel.projectId} channel={channel}/>;
}

function SpecialistProfileDialog({projectId,channel,disabled,onSaved,onClose,returnFocus}:DialogProps&{
 projectId:string;channel?:SpecialistChannelInfo;onSaved:SaveProfile;
}) {
 const titleId=useId();
 const nameInput=useRef<HTMLInputElement>(null);
 const request=useRef<{signature:string;id:string}|null>(null);
 const saving=useRef(false);
 const [name,setName]=useState(channel?.roleName??'');
 const [avatarId,setAvatarId]=useState<LakeAvatarName|''>('');
 const [duties,setDuties]=useState(channel?.duties??'');
 const [busy,setBusy]=useState(false);
 const [error,setError]=useState('');
 const title=channel?'编辑专员':'新建专员';
 const profile={name:name.trim().replace(/\s+/g,' '),duties:duties.trim()};
 const changes={
  ...(profile.name!==channel?.roleName.trim().replace(/\s+/g,' ')&&{name:profile.name}),
  ...(profile.duties!==(channel?.duties??'').trim()&&{duties:profile.duties}),
 };
 const ready=!!profile.name&&!disabled&&!busy&&(channel
  ? channel.roleRevision!==undefined&&Object.keys(changes).length>0
  : !!(profile.duties&&avatarId));

 async function save(event:FormEvent<HTMLFormElement>,closeDialog:(force?:boolean)=>void) {
  event.preventDefault();
  if(!ready||saving.current)return;
  saving.current=true;
  setBusy(true);
  setError('');
  let saved=false;
  try {
   if(channel?.roleRevision!==undefined) {
    onSaved(await api.updateSpecialist(projectId,channel.roleId,{...changes,expectedRevision:channel.roleRevision}));
   } else if(avatarId) {
    const input={...profile,avatarId};
    const signature=JSON.stringify(input);
    if(request.current?.signature!==signature)request.current={signature,id:crypto.randomUUID()};
    onSaved(await api.createSpecialist(projectId,{...input,requestId:request.current.id}));
   }
   saved=true;
  }catch(reason){
   setError(readableError(reason));
  }finally{
   saving.current=false;
   setBusy(false);
  }
  if(saved)closeDialog(true);
 }

 return <WorkbenchModalDialog className="specialist-create-dialog" labelledBy={titleId} busy={busy}
  returnFocus={returnFocus} initialFocus={nameInput} onClose={onClose}>
  {requestClose=><>
   <header className="workbench-dialog-header">
    <h2 id={titleId}>{title}</h2>
    <button type="button" className="icon-button" aria-label={`关闭${title}`} disabled={busy} onClick={()=>requestClose()}><Glyph name="close" size={16}/></button>
   </header>
   <form className="workbench-dialog-form" onSubmit={event=>void save(event,requestClose)}>
    <div className="workbench-dialog-body">
     {!channel&&<label className="field-label">动物头像
      <AppSelect value={avatarId} label="动物头像" required disabled={busy}
       icon={avatarId?<SuperRoleAvatar avatarId={avatarId} size={22}/>:undefined}
       renderOption={option=><>{isLakeAvatarName(option.value)&&<SuperRoleAvatar avatarId={option.value} size={22}/>}<span>{option.label}</span></>}
       onChange={event=>{const value=event.target.value;if(isLakeAvatarName(value))setAvatarId(value);}}>
       <option value="" disabled>选择动物</option>
       {animalGroups.map(group=><optgroup key={group.family} label={group.label}>
        {group.avatars.map(avatar=><option key={avatar.id} value={avatar.id}>{avatar.name}</option>)}
       </optgroup>)}
      </AppSelect>
     </label>}
     <label className="field-label">名称
      <input ref={nameInput} required maxLength={128} disabled={busy} value={name} onChange={event=>setName(event.target.value)}/>
     </label>
     <label className="field-label">角色描述
      <textarea required={!channel} maxLength={4096} rows={4} disabled={busy} value={duties} onChange={event=>setDuties(event.target.value)}/>
     </label>
     {error&&<p className="form-error" role="alert">{error}</p>}
    </div>
    <footer className="workbench-dialog-footer">
     <button type="button" className="button secondary" disabled={busy} onClick={()=>requestClose()}>取消</button>
     <button type="submit" className="button primary" disabled={!ready}>{channel?(busy?'正在保存…':'保存修改'):(busy?'正在创建…':'创建专员')}</button>
    </footer>
   </form>
  </>}
 </WorkbenchModalDialog>;
}
