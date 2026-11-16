import type {AICard,SessionEvent} from '../../web-agent/shared/contracts';
import type {ExternalEvent,ExternalRun} from './acp/types';

/** Only a root Worker's public ACP text gets a prefix event; the audit card stays an operation. */
export function externalReplyTextUpdate(run:Pick<ExternalRun,'purpose'|'childSessionId'|'agentRunId'>,event:Pick<ExternalEvent,'kind'>,card:AICard,rootTurnId?:string):Partial<SessionEvent>{
 if(event.kind!=='text'||run.purpose!=='worker'||run.childSessionId||run.agentRunId||!rootTurnId)return {};
 const reply=(card.data as {external_reply?:{id?:unknown;content?:unknown}}|undefined)?.external_reply;
 const externalReply=typeof reply?.id==='string'&&reply.id&&typeof reply.content==='string'?{id:reply.id,content:reply.content}:undefined;
 return {textUpdate:{target:'card',id:card.id,content:card.content??'',cardType:'operation',at:card.at,rootTurnId,...(externalReply&&{externalReply})}};
}
