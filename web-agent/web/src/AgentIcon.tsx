import {Glyph} from "./Icons";

export type AgentIconName = "lake" | "host" | "application" | "data" | "network" | "change" | "verify" | "plan" | "memory" | "other";

/** Stable role shapes. Status and motion belong to a separate status mark. */
export function AgentIcon({role,size=18,className=""}:{role:AgentIconName;size?:number;className?:string}) {
 const style=`agent-role-icon ${className}`;
 if(role==="lake")return <svg className={style} width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="m12 2 9 5-9 5-9-5 9-5Z"/><path d="m3 9 8 4.5V23l-8-4.5V9Zm10 4.5L21 9v9.5L13 23v-9.5Z"/></svg>;
 const icons={host:"server",application:"search",data:"database",network:"network",change:"code",verify:"shield",plan:"layers",memory:"book",other:"box"};
 return <Glyph name={icons[role]} size={size} className={style}/>;
}
