import type {ReactNode} from 'react';
import {StatusText} from './StatusText';

/** Process metadata has its own typography, separate from a speaker's prose. */
export function ReplyProcessStatus({children,active=false}:{children:ReactNode;active?:boolean}){
 return <div className="reply-process-status reply-process-text" role="status">
  <StatusText active={active}>{children}</StatusText>
 </div>;
}
