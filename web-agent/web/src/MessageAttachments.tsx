import type {Message} from '../../shared/contracts';
import {Glyph} from './Icons';
import {MessageImages} from './MessageImages';

/** Shared by ordinary messages and a specialist's in-place delivered report. */
export function MessageAttachments({message,sessionId}:{message:Message;sessionId:string}){
 return <>{message.files?.length?<div className="message-attachments">{message.files.map(file=><a key={file.sourceId} href={`/api/sessions/${encodeURIComponent(sessionId)}/attachments/${encodeURIComponent(file.sourceId)}`} download={file.name}><Glyph name="file" size={14}/>{file.name}</a>)}</div>:null}{!!message.images?.length&&<MessageImages images={message.images}/>}</>;
}
