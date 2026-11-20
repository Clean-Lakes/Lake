import type {SpecialistReplyAuthor} from '../../shared/contracts';
import {AgentIcon} from './AgentIcon';
import {SuperRoleAvatar} from './SuperRoleAvatar';
import {Glyph} from './Icons';
import type {AvatarMotion} from './superAgentPresentation';
import type {AgentBackendRef} from '../../shared/external-agents';
import {AgentBackendLogo,agentTypeName} from './AgentBackendLogo';
import type {LakeAvatarName} from './lakeAvatarCatalog';
import {LiveTextMotionLabel} from './liveTextMotion';

export type AssistantIdentity={name:string;roleId?:string;avatarId?:LakeAvatarName;pilot?:boolean;execution?:AgentBackendRef};
export function showsReplyAvatar(identity?:AssistantIdentity){return !identity||!!identity.pilot;}
export function ReplyIdentity({identity,author,onSpecialist,hidden=false,continued=false,motion='idle',authorMotion='idle',nameMotion}:{identity?:AssistantIdentity;author?:SpecialistReplyAuthor;onSpecialist?:(author:SpecialistReplyAuthor)=>void;hidden?:boolean;continued?:boolean;motion?:AvatarMotion;authorMotion?:AvatarMotion;nameMotion?:boolean}) {
 if(hidden)return null;
 const name=author?.name??identity?.name??'Lake';
 if(continued)return <span className="reply-continued-author">{name}</span>;
 const avatar=showsReplyAvatar(identity);
 const backend=author?author.execution:identity?.pilot?undefined:identity?.execution;
 const targetLabel=`查看${name}的${author?.channelSessionId || author?.taskId ? '任务记录' : '记录'}${backend?` · Agent 类型：${agentTypeName(backend)}`:''}`;
 const content=<>{avatar&&<span className="response-avatar" data-report-avatar={author&&(author.roleId||author.workerId)} aria-hidden="true">{author||identity?<SuperRoleAvatar name={name} roleId={author?.roleId??identity?.roleId} avatarId={author?author.avatarId:identity?.avatarId} pilot={!author&&identity?.pilot} size={28} motion={author?authorMotion:motion}/>:<AgentIcon role="lake" size={28}/>}</span>}<strong>{author&&nameMotion!==undefined?<LiveTextMotionLabel active={nameMotion} glow leading className="reply-author-name-motion">{name}</LiveTextMotionLabel>:name}</strong><AgentBackendLogo backend={backend}/></>;
 return <div className={`response-identity${avatar?'':' without-avatar'}`}>{author&&onSpecialist?<button type="button" className="response-author" onClick={()=>onSpecialist(author)} title={targetLabel} aria-label={targetLabel}>{content}<Glyph name="next" size={12}/></button>:content}</div>;
}
