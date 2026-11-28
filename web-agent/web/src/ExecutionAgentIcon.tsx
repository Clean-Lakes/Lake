import {Glyph} from './Icons';
import {ProviderIcon} from './ProviderIcon';
import {AgentIcon} from './AgentIcon';
import {isExternalAgentId,type ExternalAgentId} from '../../shared/external-agents';

export const executionAgentBrands:Record<ExternalAgentId,string>={codex:'openai','claude-code':'claude',antigravity:'antigravity'};

export function ExecutionAgentIcon({agent,size=16}:{agent?:string;size?:number}){
 return isExternalAgentId(agent)?<ProviderIcon brand={executionAgentBrands[agent]} size={size}/>:agent?<Glyph name="link" size={size}/>:<AgentIcon role="coordinator" size={size}/>;
}
