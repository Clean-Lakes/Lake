import {AgentIcon} from './AgentIcon';
import {superWorkerAppearance,type AvatarMotion} from './superAgentPresentation';
import {useEffect,useRef,useSyncExternalStore,type CSSProperties} from 'react';
import {lakeAvatarMotions} from './lakeAvatarMotion';

const subscribeVisibility=(notify:()=>void)=>{document.addEventListener('visibilitychange',notify);return()=>document.removeEventListener('visibilitychange',notify);};
const pageVisible=()=>!document.hidden;

/** A brief greeting on conversation entry, separate from live work motion. */
export function greetRoleAvatar(container:HTMLElement) {
 if(document.hidden||window.matchMedia('(prefers-reduced-motion: reduce)').matches)return;
 const avatar=container.querySelector<HTMLElement>('.super-role-avatar');
 if(!avatar)return;
 avatar.classList.remove('is-greeting');
 // Restart only this short gesture, including a second click on the same chat.
 void avatar.offsetWidth;
 avatar.classList.add('is-greeting');
}

/** The same Lake ecosystem silhouette in navigation, the island and task details. */
export function SuperRoleAvatar({name='',roleId,pilot=false,size=22,motion='idle'}:{name?:string;roleId?:string;pilot?:boolean;size?:number;motion?:AvatarMotion}) {
 const avatarRef=useRef<HTMLSpanElement>(null);
 useEffect(()=>{const media=window.matchMedia('(prefers-reduced-motion: reduce)');const reset=()=>{if(media.matches)avatarRef.current?.classList.remove('is-greeting');};media.addEventListener('change',reset);return()=>media.removeEventListener('change',reset);},[]);
 const visible=useSyncExternalStore(subscribeVisibility,pageVisible,()=>true);
 const look=superWorkerAppearance({roleId,roleName:name}),role=pilot?'coordinator':look.icon;
 const style={'--avatar-phase':`${look.phase}ms`,'--avatar-greet-time':`${pilot?650:lakeAvatarMotions[look.icon].greetMs}ms`} as CSSProperties;
 return <span ref={avatarRef} className="super-role-avatar" data-role={role} data-palette={pilot?'river':look.palette} data-variant={look.variant} data-motion={motion} data-hidden={!visible||undefined} style={style} aria-hidden="true" onAnimationEnd={event=>{if(event.target===event.currentTarget&&event.animationName==='lake-avatar-greet-done')event.currentTarget.classList.remove('is-greeting');}}><AgentIcon role={role} size={size}/></span>;
}
