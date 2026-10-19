import type {MessageMention,Resource} from "../../shared/contracts";
import {Glyph,ResourceIcon} from "./Icons";
import {AgentIcon,type AgentIconName} from "./AgentIcon";
import {messageTextParts} from "./messageMentions";
export function MessageText({text,mentions,resources=[]}:{text:string;mentions?:MessageMention[];resources?:Pick<Resource,"id"|"name"|"kind">[]}) {
 return <>{messageTextParts(text,mentions,resources).map((part,index)=>part.mention?<span className="message-reference-token" key={index} data-message-reference={`${part.mention.kind}:${part.mention.id}`} title={part.text}>{part.mention.kind==="resource"?<ResourceIcon kind={part.mention.resourceKind??resources.find(r=>r.id===part.mention!.id)?.kind??"ssh"} size={13}/>:part.mention.kind==="role"?<AgentIcon role={part.mention.id as AgentIconName} size={14}/>:<Glyph name={part.mention.kind==="skill"?"book":"plug"} size={13}/>}<span>{part.text}</span></span>:part.text)}</>;
}
