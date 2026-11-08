import {useEffect,useRef,useState,type RefObject} from 'react';
import {createPortal} from 'react-dom';
import type {SpecialistChannelInfo} from '../../shared/contracts';
import {api,readableError} from './api';
import {Glyph} from './Icons';

export function SpecialistDelete({channel,onClose,onDeleted,returnFocus}:{channel:SpecialistChannelInfo;onClose:()=>void;onDeleted:()=>void;returnFocus:RefObject<HTMLButtonElement|null>}) {
 const dialog=useRef<HTMLDialogElement>(null),cancel=useRef<HTMLButtonElement>(null);
 const errorMessage=useRef<HTMLParagraphElement>(null);
 const [busy,setBusy]=useState(false),[error,setError]=useState('');
 useEffect(()=>{const element=dialog.current;element?.showModal();cancel.current?.focus();return()=>{element?.close();returnFocus.current?.focus({preventScroll:true});};},[returnFocus]);
 useEffect(()=>{if(error&&!busy)errorMessage.current?.focus();},[error,busy]);
 async function remove(){
  if(busy)return;setBusy(true);setError('');
  try{await api.deleteSpecialist(channel.projectId,channel.roleId,channel.roleRevision!);onDeleted();onClose();}
  catch(reason){setError(readableError(reason));}finally{setBusy(false);}
 }
 return createPortal(<dialog ref={dialog} className="modal navigation-delete-dialog specialist-delete-dialog" aria-labelledby="delete-specialist-title" aria-describedby="delete-specialist-description" onCancel={event=>{event.preventDefault();if(!busy)onClose();}}>
  <div className="modal-header"><span className="modal-icon danger-icon"><Glyph name="trash" size={20}/></span><button type="button" className="icon-button" aria-label="关闭删除确认" disabled={busy} onClick={onClose}><Glyph name="close" size={14}/></button></div>
  <h2 id="delete-specialist-title">删除专员「{channel.roleName}」？</h2>
  <p className="modal-description" id="delete-specialist-description">将停止该专员的当前及待派发任务，并从侧栏移除。历史对话、任务和操作记录保留。</p>
  {error&&<p ref={errorMessage} className="form-error" role="alert" tabIndex={-1}>{error}</p>}
  <div className="modal-actions"><button ref={cancel} type="button" className="button secondary" disabled={busy} onClick={onClose}>取消</button><button type="button" className="button danger" disabled={busy} onClick={()=>void remove()}>{busy?'正在删除…':'删除专员'}</button></div>
 </dialog>,document.body);
}
