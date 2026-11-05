import {AgentIcon,type AgentIconName} from './AgentIcon';
import {SuperRoleAvatar} from './SuperRoleAvatar';

export function RoleMentionAvatar({id,name,size=18}:{id:string;name:string;size?:number}) {
 return ['coordinator','investigator','executor','verifier'].includes(id)?<AgentIcon role={id as AgentIconName} size={size}/>:<SuperRoleAvatar name={name} roleId={id} size={size}/>;
}
