import {AgentIcon} from './AgentIcon';
import {superWorkerAppearance,type AvatarMotion} from './superAgentPresentation';
import {useSyncExternalStore,type CSSProperties} from 'react';

const subscribeVisibility=(notify:()=>void)=>{document.addEventListener('visibilitychange',notify);return()=>document.removeEventListener('visibilitychange',notify);};
const pageVisible=()=>!document.hidden;

/** The same Lake ecosystem silhouette in navigation, the island and task details. */
export function SuperRoleAvatar({name='',roleId,pilot=false,size=22,motion='idle'}:{name?:string;roleId?:string;pilot?:boolean;size?:number;motion?:AvatarMotion}) {
 const visible=useSyncExternalStore(subscribeVisibility,pageVisible,()=>true);
 const look=superWorkerAppearance({roleId,roleName:name}),role=pilot?'coordinator':look.icon;
 const style={'--avatar-phase':`${look.phase}ms`} as CSSProperties;
 return <span className="super-role-avatar" data-role={role} data-palette={pilot?'river':look.palette} data-variant={look.variant} data-motion={motion} data-hidden={!visible||undefined} style={style} aria-hidden="true"><AgentIcon role={role} size={size}/></span>;
}
