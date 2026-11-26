import type {Message} from '../../shared/contracts';
import {AttachmentCardDetails} from './AttachmentCard';
import {attachmentURL} from './fileAttachments';
import {Glyph} from './Icons';
import {MessageImages} from './MessageImages';

/** Shared by ordinary messages and a specialist's in-place delivered report. */
export function MessageAttachments({message,sessionId}:{message:Message;sessionId:string}){
 return <>{message.files?.length?<div className="message-attachments">{message.files.map(file=>{
  const url=attachmentURL(sessionId,file.sourceId);
  return <a className="chat-attachment-card" key={file.sourceId} href={url} download={file.name} aria-label={`下载 ${file.name}`}>
   <AttachmentCardDetails file={file} preview={file.preview==='image'?`${url}?preview=1`:undefined}/>
   <Glyph name="down" size={15} className="chat-attachment-status"/>
  </a>;
 })}</div>:null}{!!message.images?.length&&<MessageImages images={message.images}/>}</>;
}
