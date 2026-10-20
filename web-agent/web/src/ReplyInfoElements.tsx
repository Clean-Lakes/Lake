import {useEffect,useState,type ComponentPropsWithoutRef,type ReactNode} from 'react';
import type {ExtraProps} from 'react-markdown';
import {Glyph} from './Icons';
import {quantityParts,resourceLink} from './replyInfo';

export function ReplyInfoSpan({node,children,className,...props}:ComponentPropsWithoutRef<'span'>&ExtraProps){
 const [state,setState]=useState<'idle'|'copied'|'error'>('idle');
 useEffect(()=>{if(state==='idle')return;const timer=setTimeout(()=>setState('idle'),2000);return()=>clearTimeout(timer);},[state]);
 if(!className?.split(' ').includes('reply-commit-token'))return <span className={className} {...props}>{children}</span>;
 const text=node?.children.map(child=>child.type==='element'?child.children.map(part=>part.type==='text'?part.value:'').join(''):child.type==='text'?child.value:'').join('')??'';
 async function copy(){try{await navigator.clipboard.writeText(text);setState('copied');}catch{setState('error');}}
 return <span {...props} className={className}>{children}<button type="button" aria-label={`复制提交号 ${text}`} title={state==='copied'?'已复制':'复制提交号'} onClick={()=>void copy()}><Glyph name={state==='copied'?'check':'copy'} size={13}/></button><span className="visually-hidden" role="status">{state==='copied'?'已复制提交号':''}</span>{state==='error'&&<span className="reply-copy-error" role="alert">复制失败</span>}</span>;
}

export function ReplyInfoLink({node,children,className,href,...props}:ComponentPropsWithoutRef<'a'>&ExtraProps){
 const resource=className?.split(' ').includes('reply-resource-link')&&resourceLink(href??'');
 return <a {...props} className={className} href={href} target="_blank" rel="noopener noreferrer">{resource?<><Glyph name="document" size={15}/><span className="reply-resource-text"><span>{children}</span><small>{resource.source}</small></span><Glyph name="arrow" size={14} className="reply-resource-arrow"/></>:children}</a>;
}

function quantities(children:ReactNode):ReactNode{
 if(typeof children==='string')return quantityParts(children).map((part,i)=>part.unit?<span className="reply-quantity" key={i}><span className="reply-number">{part.value}</span><span className="reply-unit">{part.unit}</span></span>:part.value);
 if(Array.isArray(children))return children.map((child,i)=><span key={i}>{quantities(child)}</span>);
 return children;
}
export function ReplyInfoValue({node,children,...props}:ComponentPropsWithoutRef<'dd'>&ExtraProps){
 return <dd {...props}>{quantities(children)}</dd>;
}

// Stable renderer references keep copy feedback and focused links mounted as
// subsequent streaming snapshots arrive.
export const replyInfoComponents={span:ReplyInfoSpan,a:ReplyInfoLink,dd:ReplyInfoValue};
