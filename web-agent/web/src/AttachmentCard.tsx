import {useState} from 'react';
import {Glyph} from './Icons';
import {attachmentPresentation, fileSize} from './fileAttachments';

type FileLabel = {name:string;mimeType?:string;sizeBytes?:number};
type UploadState = 'waiting' | 'uploading';

function FileTile({kind,icon,preview}:{kind:string;icon:string;preview?:string}) {
 const [failed,setFailed]=useState(false);
 return <span className="chat-attachment-tile" data-kind={kind} aria-hidden="true">
  {preview&&!failed?<img src={preview} alt="" draggable={false} onError={()=>setFailed(true)}/>:<Glyph name={icon} size={18}/>}
 </span>;
}

/** The same filename, size and type glyph appear in drafts and sent messages. */
export function AttachmentCardDetails({file,preview,upload}:{file:FileLabel;preview?:string;upload?:UploadState}) {
 const {kind,icon,label}=attachmentPresentation(file.name,file.mimeType);
 const detail=[label,fileSize(file.sizeBytes)].filter(Boolean).join(' · ');
 return <>
  <FileTile key={preview} kind={kind} icon={icon} preview={preview}/>
  <span className="chat-attachment-text">
   <span className="chat-attachment-name" title={file.name}>{file.name}</span>
   <small>{upload==='uploading'?'正在上传':upload==='waiting'?'等待上传':detail}</small>
  </span>
 </>;
}
