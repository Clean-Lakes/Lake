import type {ReactNode} from 'react';

// A single mounted container from first text through completion and refresh.
export function SettledReply({continued=false,roleBreak=false,children}:{continued?:boolean;roleBreak?:boolean;children:ReactNode}) {
 return <div className={`settled-reply${continued?' is-reply-continuation':''}${roleBreak?' is-role-break':''}`}><div className="settled-reply-content">{children}</div></div>;
}
