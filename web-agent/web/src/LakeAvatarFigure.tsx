import type {CSSProperties} from 'react';
import {lakeAvatarDefinition,type LakeAvatarName} from './lakeAvatarCatalog';
import {avatarPaintStyle,lakeAvatarArtwork} from './lakeAvatarArtwork';
import {avatarMotionStyle} from './lakeAvatarMotion';
export type {LakeAvatarName} from './lakeAvatarCatalog';

/** Soft, articulated local artwork, shared by every product view and export. */
export function LakeAvatarFigure({role,size,className}:{role:LakeAvatarName;size:number;className:string}) {
 const definition=lakeAvatarDefinition(role),art=lakeAvatarArtwork[role];
 return <svg className={`${className} lake-avatar-figure`} data-family={definition.family} data-avatar={role} width={size} height={size} viewBox="0 0 64 64" fill="none" style={{...avatarPaintStyle(art.palette),...avatarMotionStyle(role)} as CSSProperties} aria-hidden="true">
  <g className="avatar-greeting"><g className="avatar-body"><g transform={art.fit}>
   {art.parts.map((part,index)=><g key={index} className={`avatar-part avatar-${part.name}`} style={{transformBox:'view-box',transformOrigin:`${part.pivot[0]}px ${part.pivot[1]}px`}}>
    {part.shapes.map((shape,i)=><path key={i} d={shape.d} fill={shape.line?'none':`var(--avatar-${shape.tone})`} stroke={shape.line?`var(--avatar-${shape.tone})`:undefined} strokeWidth={shape.line?shape.width:undefined} opacity={shape.opacity===1?undefined:shape.opacity} strokeLinecap="round" strokeLinejoin="round"/>)}
    {part.eyes?.map(([x,y],i)=><g key={`eye-${i}`} className="avatar-eye"><ellipse cx={x} cy={y} rx="1.15" ry="1.35" fill="var(--avatar-eye)"/><circle cx={x+.3} cy={y-.4} r=".3" fill="var(--avatar-soft)"/></g>)}
   </g>)}
  </g></g></g>
 </svg>;
}
