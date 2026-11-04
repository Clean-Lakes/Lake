import {lakeAvatarDefinition,type LakeAvatarName} from './lakeAvatarCatalog';
export type {LakeAvatarName} from './lakeAvatarCatalog';

/** Local Lake silhouettes: separate moving parts keep the identity itself fixed. */
export function LakeAvatarFigure({role,size,className}:{role:LakeAvatarName;size:number;className:string}) {
 const eye=(x:number,y:number)=><ellipse className="avatar-eye" cx={x} cy={y} rx=".65" ry=".7" fill="var(--background)"/>;
 const definition=lakeAvatarDefinition(role);
 return <svg className={`${className} lake-avatar-figure`} data-family={definition.family} width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
  <g className="avatar-body" fill="currentColor" strokeLinejoin="round" strokeLinecap="round">
   {definition.body&&<g transform={definition.fit}><path className={definition.family==='lotus'?'avatar-limb':undefined} d={definition.body}/>{definition.limb&&<path className="avatar-limb" d={definition.limb} stroke="currentColor" strokeWidth="1.2" fill="none"/>}{definition.detail&&<path d={definition.detail} stroke="var(--background)" strokeWidth=".85" fill="none"/>}{definition.eyes?.map(([x,y],index)=><ellipse key={index} className="avatar-eye" cx={x} cy={y} rx=".65" ry=".7" fill="var(--background)"/>)}</g>}
   {role==='heron'&&<><path d="m15.6 2.8 5.3 2-4.5.9c-2.3.4-2.7 2-2.4 4.2l.3 2.2c.3 2.6-2 4.6-6.3 5.6l-4 .6 4.7-5.7c1.2-1.5 2.4-2.2 3.8-2.6l-.6-1.6c-1-2.7.2-4.7 3.7-5.6Z"/><path className="avatar-limb" d="m8 15 3-2" stroke="var(--background)" strokeWidth=".8"/>{eye(15.6,4.4)}<path d="m9.8 17.6-.4 3m3-4-.5 4M6.5 22h10" fill="none" stroke="currentColor" strokeWidth="1.1"/></>}
   {role==='otter'&&<><path d="M8 14.3C4.4 13.6 2 14 1.8 16.1c-.2 1.9 3.2 2.6 6.8.8Z"/><path d="M7 13.1c0-2.7 1.4-4.8 3.7-5.7l-.4-1.7 2.2.2c2.4-.6 4.4.6 5.5 2.5l3 .9-2.3 1.8c.1 4.5-1.7 8.1-5.9 8.1-3.6 0-6-2.5-5.8-6.1Z"/>{eye(16,8.6)}<path className="avatar-limb" d="m11.5 14 3.4 1.2" stroke="var(--background)" strokeWidth="1"/><path d="M10 20.5h7" stroke="currentColor" strokeWidth="1.2"/></>}
   {role==='turtle'&&<><path className="avatar-limb" d="m5 16-2 3 4-1m8-1 3 2-.1-4M5 10 3 8l4 .4" stroke="currentColor" strokeWidth="1.6"/><path d="M2.5 13.8c.2-5.6 4-9 8.6-8.2 4.4.8 6.4 4.4 6.2 9.4-4.2 2.4-10.2 2.1-14.8-1.2Z"/><path d="m6.5 8.5 3 4.2-.7 3m.7-3 5.7-2.5" stroke="var(--background)" strokeWidth=".9"/><path d="M16 12.1c0-2.7 3-4.2 5-2.6 1.9 1.5.6 5.1-2 5.5l-3-1Z"/>{eye(20,11.4)}</>}
   {role==='kingfisher'&&<><path d="m4 19 4-7c-.4-4.7 2.1-8.8 6-9 3.1-.2 4.4 2 4.4 4.1L23 9l-5 .8c-1.5 5.6-4.9 8.7-9 8.1Z"/><path className="avatar-limb" d="m9 12 4.5-1.5-1 5.3" stroke="var(--background)" strokeWidth="1.1"/>{eye(15.5,6)}<path d="m11 18-.7 3M5 22h13" stroke="currentColor" strokeWidth="1.1"/></>}
   {role==='dragonfly'&&<><g className="avatar-limb"><path d="M11.5 10C2.4 1.2.5 6.5 4 9.4c1.6 1.3 4 1.7 7.5 2.1ZM12.5 10C21.6 1.2 23.5 6.5 20 9.4c-1.6 1.3-4 1.7-7.5 2.1Z" opacity=".85"/><path d="M11.4 12C1.7 10.3 2 16.7 6.8 16.4c1.7-.1 3-1.5 4.6-3ZM12.6 12c9.7-1.7 9.4 4.7 4.6 4.4-1.7-.1-3-1.5-4.6-3Z" opacity=".6"/></g><path d="M11.1 6h1.8l-.3 15h-1.2Z"/><ellipse cx="12" cy="5.5" rx="2" ry="1.8"/>{eye(11.2,5.4)}{eye(12.8,5.4)}</>}
   {role==='duck'&&<><path d="M3 11.5c2 1.1 3.5 1.3 5 1 1.2-.3 2.6-1.5 3-3.1-1.2-4.2 1.1-7.1 4.2-6.4 2.1.4 2.7 2.2 2.5 4L22 9l-4.6 1.3c.5 5.7-2.8 9.2-8 8.7-4-.4-6.6-3.1-6.4-7.5Z"/><path className="avatar-limb" d="M7.5 14c1.7 1.6 4.6 1.7 6.3-.4" stroke="var(--background)" strokeWidth="1"/>{eye(15.2,6.3)}</>}
   {role==='fish'&&<><path d="M3 12C6 6.3 12.8 5.2 17 9.8L22 6v12l-5-3.8C12.8 18.8 6 17.7 3 12Z"/><path className="avatar-limb" d="m11 8 1.4-4L16 9m-5 7 1.4 4 3.6-5"/><path d="M9.3 8.5c2 2.5 2 4.5 0 7" stroke="var(--background)" strokeWidth=".9"/>{eye(6.7,11.2)}</>}
   {role==='lotus'&&<><g className="avatar-limb"><path d="M12 17C5 14 3.7 7.8 6.7 4.7c2.4 1 4 3 5.3 6.6 1.3-3.6 2.9-5.6 5.3-6.6 3 3.1 1.7 9.3-5.3 12.3Z" opacity=".7"/><path d="M12 16.5C7.4 12 8 5.8 12 2c4 3.8 4.6 10 0 14.5Z"/><path d="M12 18C5.6 17.9 2.4 14.6 2 10.2c5.2.2 8.7 2.8 10 7.8Zm0 0c6.4-.1 9.6-3.4 10-7.8-5.2.2-8.7 2.8-10 7.8Z"/></g><path d="M3 21c3-2.3 6-2.4 9-.8 3-1.6 6-1.5 9 .8-5 2-13 2-18 0Z" opacity=".6"/></>}
  </g>
  <path className="avatar-water" d="M5 22h14" stroke="currentColor" strokeWidth=".8" strokeLinecap="round" opacity=".35"/>
 </svg>;
}
