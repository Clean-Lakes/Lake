import type {MessageMention,Resource} from "../../shared/contracts";
import {Glyph,ResourceIcon} from "./Icons";
import {RoleMentionAvatar} from './RoleMentionAvatar';
import {messageTextParts} from "./messageMentions";
export function MessageText({text,mentions,resources=[]}:{text:string;mentions?:MessageMention[];resources?:Pick<Resource,"id"|"name"|"kind"|"jumpServer">[]}) {
 return <>{messageTextParts(text,mentions,resources).map((part,index)=>{
  const reference=part.mention;
  if(!reference)return part.text;
  const resource=reference.kind==="resource" ? resources.find(item=>item.id===reference.id) : undefined;
  const resourceKind=resource?.jumpServer ? "jumpserver" : reference.resourceKind ?? resource?.kind ?? "ssh";
  return <span className="message-reference-token" key={index} data-message-reference={`${reference.kind}:${reference.id}`} title={part.text}>
   {reference.kind==="resource" ? <ResourceIcon kind={resourceKind} size={13}/>
    : reference.kind==="role" ? <RoleMentionAvatar id={reference.id} name={part.text} size={14}/>
    : <Glyph name={reference.kind==="skill"?"book":"plug"} size={13}/>}
   <span>{part.text}</span>
  </span>;
 })}</>;
}
