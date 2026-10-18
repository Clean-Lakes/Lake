import type {ComponentPropsWithoutRef} from 'react';
import {Glyph} from './Icons';

/** Native disclosure behavior, shared typography and one consistent chevron. */
export function DisclosureSummary({node: _node,children,className='',...props}:ComponentPropsWithoutRef<'summary'>&{node?:unknown}){
  return <summary {...props} className={`lake-disclosure-summary ${className}`}><>{children}</><Glyph name="next" size={12} className="lake-disclosure-chevron"/></summary>;
}
