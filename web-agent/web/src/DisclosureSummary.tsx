import {useState,type ComponentPropsWithoutRef,type ReactNode} from 'react';
import {Glyph} from './Icons';

/** Native disclosure behavior, shared typography and one consistent chevron. */
export function DisclosureSummary({node: _node,children,className='',...props}:ComponentPropsWithoutRef<'summary'>&{node?:unknown}){
  return <summary {...props} className={`lake-disclosure-summary ${className}`}><>{children}</><Glyph name="next" size={12} className="lake-disclosure-chevron"/></summary>;
}

export function DeferredDisclosure({summary,children,className,summaryClassName}:{summary:ReactNode;children:ReactNode;className?:string;summaryClassName?:string}){
  const [visited,setVisited]=useState(false);
  return <details className={className} onToggle={event=>{if(event.currentTarget.open)setVisited(true);}}>
    <DisclosureSummary className={summaryClassName}>{summary}</DisclosureSummary>
    {visited&&children}
  </details>;
}
