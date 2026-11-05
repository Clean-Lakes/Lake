import type {ReactNode} from 'react';

// A single mounted container from first text through completion and refresh.
export function SettledReply({continued=false,children}:{continued?:boolean;children:ReactNode}) {
 return <div className={`settled-reply${continued?' is-reply-continuation':''}`}><div className="settled-reply-content">{children}</div></div>;
}
