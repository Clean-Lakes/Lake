import type {SpecialistReplyAuthor} from '../../shared/contracts';
import {AgentIcon} from './AgentIcon';
import {SuperRoleAvatar} from './SuperRoleAvatar';
import {Glyph} from './Icons';

export type AssistantIdentity={name:string;pilot?:boolean};
export function showsReplyAvatar(identity?:AssistantIdentity,author?:SpecialistReplyAuthor){return !author&&(!identity||!!identity.pilot);}
export function ReplyIdentity({identity,author,onSpecialist,hidden=false}:{identity?:AssistantIdentity;author?:SpecialistReplyAuthor;onSpecialist?:(author:SpecialistReplyAuthor)=>void;hidden?:boolean}) {
 if(hidden)return null;
 const name=author?.name??identity?.name??'Lake';
 const avatar=showsReplyAvatar(identity,author);
 const content=<>{avatar&&<span className="response-avatar" aria-hidden="true">{identity?<SuperRoleAvatar name={name} pilot={identity.pilot} size={20}/>:<AgentIcon role="lake" size={18}/>}</span>}<strong>{name}</strong></>;
 return <div className={`response-identity${avatar?'':' without-avatar'}`}>{author&&onSpecialist?<button type="button" className="response-author" onClick={()=>onSpecialist(author)} title={`与${name}继续沟通`} aria-label={`与${name}继续沟通`}>{content}<Glyph name="next" size={12}/></button>:content}</div>;
}
