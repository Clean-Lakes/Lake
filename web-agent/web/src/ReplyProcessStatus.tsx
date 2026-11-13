import type {ReactNode} from 'react';
import {Glyph} from './Icons';
import {LoadingWaves} from './LoadingWaves';
import {StatusText} from './StatusText';

/** Process metadata has its own typography, separate from a speaker's prose. */
export function ReplyProcessStatus({children,active=false,mark=active?'loading':'none',className=''}:{children:ReactNode;active?:boolean;mark?:'loading'|'clock'|'alert'|'check'|'none';className?:string}){
 return <div className={`reply-process-status reply-process-text ${className}`} role="status">
  {mark==='loading'?<LoadingWaves/>:mark!=='none'?<Glyph name={mark} size={14}/>:null}
  <StatusText active={active}>{children}</StatusText>
 </div>;
}
