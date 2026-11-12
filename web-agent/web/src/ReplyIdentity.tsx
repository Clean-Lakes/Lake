import type {SpecialistReplyAuthor} from '../../shared/contracts';
import {AgentIcon} from './AgentIcon';
import {SuperRoleAvatar} from './SuperRoleAvatar';
import {Glyph} from './Icons';
import type {AvatarMotion} from './superAgentPresentation';
import type {AgentBackendRef} from '../../shared/external-agents';
import {AgentBackendLogo,agentTypeName} from './AgentBackendLogo';

export type AssistantIdentity={name:string;roleId?:string;pilot?:boolean;execution?:AgentBackendRef};
export function showsReplyAvatar(identity?:AssistantIdentity){return !identity||!!identity.pilot;}
export function ReplyIdentity({identity,author,onSpecialist,hidden=false,continued=false,motion='idle'}:{identity?:AssistantIdentity;author?:SpecialistReplyAuthor;onSpecialist?:(author:SpecialistReplyAuthor)=>void;hidden?:boolean;continued?:boolean;motion?:AvatarMotion}) {
 if(hidden)return null;
 const name=author?.name??identity?.name??'Lake';
 if(continued)return <span className="reply-continued-author">{name}</span>;
 const avatar=showsReplyAvatar(identity);
 const backend=author?author.execution:identity?.pilot?undefined:identity?.execution;
 const targetLabel=`与${name}继续沟通${backend?` · Agent 类型：${agentTypeName(backend)}`:''}`;
 const content=<>{avatar&&<span className="response-avatar" aria-hidden="true">{author||identity?<SuperRoleAvatar name={name} roleId={author?.roleId??identity?.roleId} pilot={!author&&identity?.pilot} size={28} motion={author?'idle':motion}/>:<AgentIcon role="lake" size={28}/>}</span>}<strong>{name}</strong><AgentBackendLogo backend={backend}/></>;
 return <div className={`response-identity${avatar?'':' without-avatar'}`}>{author&&onSpecialist?<button type="button" className="response-author" onClick={()=>onSpecialist(author)} title={targetLabel} aria-label={targetLabel}>{content}<Glyph name="next" size={12}/></button>:content}</div>;
}
