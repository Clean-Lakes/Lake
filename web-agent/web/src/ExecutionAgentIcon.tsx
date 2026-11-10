import {Glyph} from './Icons';
import {ProviderIcon} from './ProviderIcon';

export function ExecutionAgentIcon({agent,size=16}:{agent?:string;size?:number}){
 return agent==='codex'?<ProviderIcon brand="openai" size={size}/>:<Glyph name={agent?'alert':'lakeWorkflow'} size={size}/>;
}
