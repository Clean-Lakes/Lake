import type {AICard,SessionEvent} from '../../web-agent/shared/contracts';
import type {ExternalEvent,ExternalRun} from './acp/types';

/** Only a root Worker's public ACP text gets a prefix event; the audit card stays an operation. */
export function externalReplyTextUpdate(run:Pick<ExternalRun,'purpose'|'childSessionId'|'agentRunId'>,event:Pick<ExternalEvent,'kind'>,card:AICard,rootTurnId?:string):Partial<SessionEvent>{
 if(event.kind!=='text'||run.purpose!=='worker'||run.childSessionId||run.agentRunId||!rootTurnId)return {};
 return {textUpdate:{target:'card',id:card.id,content:card.content??'',cardType:'operation',at:card.at,rootTurnId}};
}
