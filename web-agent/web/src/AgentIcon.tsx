import {Glyph} from "./Icons";

export type AgentIconName = "lake" | "host" | "application" | "data" | "network" | "change" | "verify" | "plan" | "memory" | "other" | "coordinator" | "investigator" | "executor" | "verifier";

/** Stable role shapes. Status and motion belong to a separate status mark. */
export function AgentIcon({role,size=18,className=""}:{role:AgentIconName;size?:number;className?:string}) {
 const style=`agent-role-icon ${className}`;
 if(["coordinator","investigator","executor","verifier"].includes(role))return <svg className={`${style} sre-avatar sre-avatar-${role}`} width={Math.min(size,22)} height={Math.min(size,22)} viewBox="0 0 24 24" fill="none" aria-hidden="true">
  {role==="coordinator"?<g stroke="currentColor" strokeWidth="1.2"><ellipse cx="12" cy="12" rx="10" ry="5"/><ellipse cx="12" cy="12" rx="6.5" ry="3"/><ellipse cx="12" cy="12" rx="2.5" ry="1.1"/></g>:role==="investigator"?<><path fill="currentColor" d="m15.7 3.1 4.7 1.7-4.1.8c-2.1.5-2.8 2-2.6 4l.3 2.1c.3 2.4-1.8 4.2-5.9 5.5l-3.8.7 4.4-5.5c1.1-1.4 2.2-2 3.7-2.5l-.7-1.6c-1.1-2.7.2-4.9 4-5.2Z"/><path d="m10 17-.4 4m3-5-.5 5M6 22h11" stroke="currentColor" strokeWidth="1"/></>:role==="executor"?<><path fill="currentColor" d="M8.2 12.3c-.1-4.2 2.7-6.6 6.5-5.8l1.3-1.2 1.4 1.5 2.9 1.4-2.2 1.5c.2 3.5-.7 6.3-3.7 7.5l1.1 1.5h-4.7c-1.7 0-3-1-3.3-2.6l-2.6 1.8c-2.6 1.2-4.7-.3-3.9-2.2.5-1.2 2.4-1.3 6-1.2l1.2-2.2Z"/></>:<g fill="currentColor"><path d="M11.3 21C10.7 13.7 9 10.7 6 8.8c1.3 4.8 3.9 7.6 5.3 12.2Zm1.4 0c.2-6.2 1.8-10.2 4.9-13-1 6-3.3 9.5-4.9 13Zm-3 .2C6.8 16.8 4.5 15.5 2 15.6c2.2 3.1 4.5 4.6 7.7 5.6Zm4.9 0c1-3.6 2.9-5.8 6.7-6.9-1.3 4.1-3.8 5.9-6.7 6.9Z"/><rect x="11.2" y="6" width="1" height="16"/><rect x="10.8" y="1.5" width="1.8" height="7" rx=".9"/><path d="M6 21.5h13v1H6z"/></g>}
 </svg>;
 if(role==="lake")return <svg className={style} width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="m12 2 9 5-9 5-9-5 9-5Z"/><path d="m3 9 8 4.5V23l-8-4.5V9Zm10 4.5L21 9v9.5L13 23v-9.5Z"/></svg>;
 const icons={host:"server",application:"search",data:"database",network:"network",change:"code",verify:"shield",plan:"layers",memory:"book",other:"box"};
 return <Glyph name={icons[role as keyof typeof icons]} size={size} className={style}/>;
}
