import {AgentIcon} from './AgentIcon';
import {superWorkerIcon} from './superAgentPresentation';

/** The same Lake ecosystem silhouette in navigation, the island and task details. */
export function SuperRoleAvatar({name='',pilot=false,size=22}:{name?:string;pilot?:boolean;size?:number}) {
 const role=pilot?'coordinator':superWorkerIcon({roleName:name});
 return <span className="super-role-avatar" data-role={role} aria-hidden="true"><AgentIcon role={role} size={size}/></span>;
}
