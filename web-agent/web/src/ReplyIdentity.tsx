import type {SpecialistReplyAuthor} from '../../shared/contracts';
import {AgentIcon} from './AgentIcon';
import {SuperRoleAvatar} from './SuperRoleAvatar';
import {Glyph} from './Icons';

export type AssistantIdentity={name:string;pilot?:boolean};
export function ReplyIdentity({identity,author,onSpecialist}:{identity?:AssistantIdentity;author?:SpecialistReplyAuthor;onSpecialist?:(author:SpecialistReplyAuthor)=>void}) {
 const name=author?.name??identity?.name??'Lake';
 const content=<>{author?<SuperRoleAvatar name={name} size={20}/>:identity?<SuperRoleAvatar name={name} pilot={identity.pilot} size={20}/>:<AgentIcon role="lake" size={18}/>}<strong>{name}</strong></>;
 return <div className="response-identity">{author&&onSpecialist?<button type="button" className="response-author" onClick={()=>onSpecialist(author)} title={`与${name}继续沟通`} aria-label={`与${name}继续沟通`}>{content}<Glyph name="next" size={12}/></button>:content}</div>;
}
