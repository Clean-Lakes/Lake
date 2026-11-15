import {Fragment,type CSSProperties} from 'react';
import {lakeAvatarDefinition,type LakeAvatarName} from './lakeAvatarCatalog';
import {avatarPaintStyle,lakeAvatarArtwork} from './lakeAvatarArtwork';
import {avatarMotionStyle} from './lakeAvatarMotion';
export type {LakeAvatarName} from './lakeAvatarCatalog';

/** Soft, articulated local artwork, shared by every product view and export. */
export function LakeAvatarFigure({role,size,className,thinking=false}:{role:LakeAvatarName;size:number;className:string;thinking?:boolean}) {
 const definition=lakeAvatarDefinition(role),art=lakeAvatarArtwork[role];
 const partContent=(part:typeof art.parts[number])=><>
  {part.shapes.map((shape,i)=>{
   const path=<path key={i} d={shape.d} fill={shape.line?'none':`var(--avatar-${shape.tone})`} stroke={shape.line?`var(--avatar-${shape.tone})`:undefined} strokeWidth={shape.line?shape.width:undefined} opacity={shape.opacity===1?undefined:shape.opacity} strokeLinecap="round" strokeLinejoin="round"/>;
   return thinking&&role==='fox'&&part.name==='head'&&i===0?<g key={i} className="avatar-part avatar-ear" style={{transformBox:'view-box',transformOrigin:'44px 20px'}}>{path}</g>:path;
  })}
  {part.eyes?.map(([x,y],i)=><g key={`eye-${i}`} className="avatar-eye"><ellipse cx={x} cy={y} rx="1.15" ry="1.35" fill="var(--avatar-eye)"/><circle cx={x+.3} cy={y-.4} r=".3" fill="var(--avatar-soft)"/></g>)}
 </>;
 return <svg className={`${className} lake-avatar-figure`} data-family={definition.family} data-avatar={role} width={size} height={size} viewBox="0 0 64 64" fill="none" style={{...avatarPaintStyle(art.palette),...avatarMotionStyle(role)} as CSSProperties} aria-hidden="true">
  <g className="avatar-greeting"><g className="avatar-body"><g transform={art.fit}>
   {art.parts.map((part,index)=>{
    const pivot=thinking&&role==='owl'&&part.name==='head'?[32,29]:thinking&&role==='pufferfish'&&part.name==='shell'?[29,55]:part.pivot;
    const style={transformBox:'view-box',transformOrigin:`${pivot[0]}px ${pivot[1]}px`} as CSSProperties;
    return <Fragment key={index}>
     {thinking&&role==='otter'&&part.name==='fore'&&<g className="avatar-part avatar-other" style={style}>{partContent(part)}</g>}
     <g className={`avatar-part avatar-${part.name}`} style={style}>{partContent(part)}</g>
    </Fragment>;
   })}
  </g></g></g>
 </svg>;
}
