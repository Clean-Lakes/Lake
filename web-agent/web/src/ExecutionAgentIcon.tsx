import {Glyph} from './Icons';
import {ProviderIcon} from './ProviderIcon';
import {AgentIcon} from './AgentIcon';

export function ExecutionAgentIcon({agent,size=16}:{agent?:string;size?:number}){
 return agent==='codex'?<ProviderIcon brand="openai" size={size}/>:agent?<Glyph name="link" size={size}/>:<AgentIcon role="coordinator" size={size}/>;
}
