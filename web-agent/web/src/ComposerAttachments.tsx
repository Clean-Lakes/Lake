import {useLayoutEffect, useRef} from 'react';
import type {AIImage, TextFileAttachment} from '../../shared/contracts';
import {AttachmentCardDetails} from './AttachmentCard';
import {Glyph} from './Icons';
import {attachmentURL} from './fileAttachments';

export type PendingAttachment = {id:string;name:string;mimeType?:string;sizeBytes:number};

export function ComposerAttachments({sessionId,images,files,uploads,disabled,onRemoveImage,onRemoveFile}:{
 sessionId:string;images:readonly AIImage[];files:readonly TextFileAttachment[];uploads:readonly PendingAttachment[];
 disabled:boolean;onRemoveImage:(id:string)=>void;onRemoveFile:(id:string)=>void;
}) {
 const tray=useRef<HTMLDivElement>(null),previousCount=useRef(0);
 const count=images.length+files.length+uploads.length;
 useLayoutEffect(()=>{
  const index=previousCount.current;
  previousCount.current=count;
  const row=tray.current,added=row?.children[index];
  if(count<=index||!row||!added)return;
  const edge=row.getBoundingClientRect(),card=added.getBoundingClientRect();
  if(card.right>edge.right)row.scrollTo({left:row.scrollLeft+card.right-edge.right+2,
   behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'});
 },[count]);
 if(!count)return null;
 const remove=(name:string,action:()=>void)=><button type="button" className="chat-attachment-remove"
  disabled={disabled} aria-label={`移除 ${name}`} title={`移除 ${name}`} onClick={action}><Glyph name="close" size={14}/></button>;
 return <>
  <div ref={tray} className="composer-attachment-tray" role="list" aria-label="待发送附件">
   {images.map(image=>{
    const name=image.name||'剪贴板图片';
    return <div className="chat-attachment-card composer-attachment-arrival" role="listitem" key={image.id}>
     <AttachmentCardDetails file={{name,mimeType:image.mimeType,sizeBytes:image.sizeBytes}} preview={`data:${image.mimeType};base64,${image.base64}`}/>
     {remove(name,()=>onRemoveImage(image.id))}
    </div>;
   })}
   {files.map(file=><div className="chat-attachment-card" role="listitem" key={file.sourceId}>
    <AttachmentCardDetails file={file} preview={file.preview==='image'?`${attachmentURL(sessionId,file.sourceId)}?preview=1`:undefined}/>
    {remove(file.name,()=>onRemoveFile(file.sourceId))}
   </div>)}
   {uploads.map((file,index)=><div className="chat-attachment-card composer-attachment-arrival" role="listitem" key={file.id}>
    <AttachmentCardDetails file={file} upload={index===0?'uploading':'waiting'}/>
    {index===0&&<Glyph name="loader" size={15} className="chat-attachment-status"/>}
   </div>)}
  </div>
  <span className="visually-hidden" role="status">{uploads.length?`正在添加 ${uploads.length} 个附件`:''}</span>
 </>;
}
