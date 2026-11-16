import {Fragment,useRef,type CSSProperties,type ReactNode} from 'react';
import {usePageVisible} from './usePageVisible';
import {useSynchronizedLight} from './synchronizedLight';

export const LIVE_TEXT_MOTION_LIMIT=24;
// Keep a bounded stagger and a quiet pause in both prose and shared light cycles.
const phaseWindowMs=2800;
const segmenter=new Intl.Segmenter(undefined,{granularity:'grapheme'});
type TextNode={type:string;value?:string;children?:TextNode[];data?:{hName?:string;hProperties?:Record<string,unknown>}};
const opaque=new Set(['code','inlineCode','link','linkReference','image','imageReference','html','definition','table']);

function readableTail(text:string,limit=LIVE_TEXT_MOTION_LIMIT){
 const readable:number[]=[];
 for(const part of segmenter.segment(text))if(part.segment.trim()){
  readable.push(part.index);if(readable.length>limit)readable.shift();
 }
 return {start:readable[0]??text.length,count:readable.length};
}

function readableHeadEnd(text:string){
 let count=0,end=0;
 for(const part of segmenter.segment(text))if(part.segment.trim()){
  end=part.index+part.segment.length;
  if(++count===LIVE_TEXT_MOTION_LIMIT)break;
 }
 return end;
}

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
   const {count,start}=readableTail(value,remaining);
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
export function LiveTextMotionText({text,start,end=text.length}:{text:string;start:number;end?:number}){
 return <span className="live-text-motion-text"><Fragment key="prefix">{text.slice(0,start)}</Fragment>{liveTextMotionParts(text.slice(0,end),start).map(part=><Fragment key={part.offset}>{part.moving?<span className="live-text-motion-character" data-text-offset={part.offset} style={{'--live-text-phase':`${-(part.offset*73%phaseWindowMs)}ms`} as CSSProperties}>{part.text}</span>:part.text}</Fragment>)}<Fragment key="suffix">{text.slice(end)}</Fragment></span>;
}

/** Pure status text shares the prose motion without Markdown or a second live region. */
export function LiveTextMotionLabel({children,active=false,glow=false,leading=false,className=''}:{children:string;active?:boolean;glow?:boolean;leading?:boolean;className?:string}){
 const visible=usePageVisible();
 const lightRef=useRef<HTMLSpanElement>(null);
 // Ellipsized names expose their beginning; streaming prose exposes its tail.
 const range=leading?{start:0,end:readableHeadEnd(children)}:{start:readableTail(children).start,end:children.length};
 const running=active&&visible;
 useSynchronizedLight(lightRef,glow&&running);
 return <span ref={lightRef} className={`live-text-motion-label${className?` ${className}`:''}`} data-live-motion={running?'active':'still'} data-live-glow={glow?running?'active':'still':undefined}><LiveTextMotionText text={children} {...range}/></span>;
}

/** Ordinary Markdown does not subscribe to visibility or acquire motion markup. */
export function LiveTextMotionBoundary({active,className,children}:{active:boolean;className:string;children:ReactNode}){
 const visible=usePageVisible();
 return <div className={className} data-live-motion={active&&visible?'active':'still'}>{children}</div>;
}
