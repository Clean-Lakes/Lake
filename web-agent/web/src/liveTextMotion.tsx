import {Fragment,type CSSProperties,type ReactNode} from 'react';
import {usePageVisible} from './usePageVisible';

export const LIVE_TEXT_MOTION_LIMIT=24;
// Stagger within part of the 4200ms CSS cycle, leaving a quiet pause between waves.
const phaseWindowMs=2800;
const segmenter=new Intl.Segmenter(undefined,{granularity:'grapheme'});
type TextNode={type:string;value?:string;children?:TextNode[];data?:{hName?:string;hProperties?:Record<string,unknown>}};
const opaque=new Set(['code','inlineCode','link','linkReference','image','imageReference','html','definition','table']);

/** Decorate a bounded tail of plain prose, after references and other Markdown features. */
export function remarkLiveTextMotion(){
 return (tree:TextNode)=>{
  const textNodes:TextNode[]=[];
  function collect(node:TextNode){
   if(opaque.has(node.type)||node.data?.hName)return;
   if(node.type==='text'&&node.value?.trim())textNodes.push(node);
   else node.children?.forEach(collect);
  }
  collect(tree);
  let remaining=LIVE_TEXT_MOTION_LIMIT;
  for(let index=textNodes.length-1;index>=0&&remaining>0;index--){
   const node=textNodes[index]!,value=node.value!;
   const readable:number[]=[];
   for(const part of segmenter.segment(value))if(part.segment.trim()){
    readable.push(part.index);if(readable.length>remaining)readable.shift();
   }
   const count=readable.length,start=readable[0]!;
   node.type='liveTextMotion';
   // react-markdown keys siblings by tag name. A private renderer keeps the
   // bounded motion hosts out of existing reference/commit span key sequences.
   node.data={hName:'lake-live-text',hProperties:{'data-live-text-start':start}};
   node.children=[{type:'text',value}];delete node.value;
   remaining-=count;
  }
 };
}

export function liveTextMotionParts(text:string,start:number){
 const parts:{text:string;offset:number;moving:boolean}[]=[];
 for(const part of segmenter.segment(text.slice(start))){
  const moving=!!part.segment.trim(),previous=parts.at(-1);
  if(!moving&&previous&&!previous.moving)previous.text+=part.segment;
  else parts.push({text:part.segment,offset:start+part.index,moving});
 }
 return parts;
}

/** Inline spans preserve normal line breaking, selectable text and one readable copy. */
export function LiveTextMotionText({text,start}:{text:string;start:number}){
 return <span className="live-text-motion-text"><Fragment key="prefix">{text.slice(0,start)}</Fragment>{liveTextMotionParts(text,start).map(part=><Fragment key={part.offset}>{part.moving?<span className="live-text-motion-character" data-text-offset={part.offset} style={{'--live-text-phase':`${-(part.offset*73%phaseWindowMs)}ms`} as CSSProperties}>{part.text}</span>:part.text}</Fragment>)}</span>;
}

/** Ordinary Markdown does not subscribe to visibility or acquire motion markup. */
export function LiveTextMotionBoundary({active,className,children}:{active:boolean;className:string;children:ReactNode}){
 const visible=usePageVisible();
 return <div className={className} data-live-motion={active&&visible?'active':'still'}>{children}</div>;
}
