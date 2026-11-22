import {createContext,useContext,useLayoutEffect,useMemo,useRef,type ReactNode} from 'react';
import type {ExtraProps} from 'react-markdown';
import {SpecialistReplyFeather,SpecialistReplyFeatherTail} from './SpecialistReplyFeather';
import {useSmoothText} from './useSmoothText';

export type MarkdownRevealOptions = {active: boolean; animateInitial?: boolean; finishPending?: boolean};

type ProseNode = {
  type: string;
  value?: string;
  children?: ProseNode[];
  position?: {end: {offset?: number}};
  data?: {hName?: string; hProperties?: Record<string, unknown>};
};

const textContainers = new Set(['root','paragraph','heading','blockquote','list','listItem','strong','emphasis','delete']);
const inlineContainers = new Set(['paragraph','heading','strong','emphasis','delete']);
const invisibleTailNodes = new Set(['definition','html','break']);
const VisibleOffset = createContext<number | undefined>(undefined);

function wrapRevealText(node:ProseNode,start?:number) {
  node.type='lakeRevealText';
  const properties:Record<string,unknown>=start===undefined?{}:{'data-reveal-start':start};
  node.data={hName:'lake-reveal-text',hProperties:properties};
  node.children=[{type:'text',value:node.value}];
  delete node.value;
}

/** Preserve the playout cursor across paragraph and inline formatting boundaries. */
export function remarkRevealText(paintedThrough:number) {
  return () => (tree: ProseNode, file: {value: unknown}) => {
    const source=String(file.value??'');
    function visit(node:ProseNode,inheritedEnd?:number) {
      const end=node.position?.end.offset??inheritedEnd;
      if(node.data?.hName||end!==undefined&&end<=paintedThrough)return;
      if(textContainers.has(node.type)){
        const children=node.children??[];
        for(let index=children.length-1;index>=0;index--){
          const child=children[index]!;
          if(child.position?.end.offset!==undefined&&child.position.end.offset<=paintedThrough)break;
          visit(child,index===children.length-1?end:undefined);
        }
        return;
      }
      // Links, code, tables and decorated references keep their parser-owned
      // structure. A literal text leaf can safely be sliced at source offsets.
      if(node.type!=='text'||!node.value||end===undefined)return;
      const value=node.value,start=end-value.length;
      if(start<0||source.slice(start,end)!==value)return;
      wrapRevealText(node,start);
    }
    visit(tree);
  };
}

/** Attach to the last prose leaf, keeping formatted inline nodes and the reveal clock intact. */
export function remarkSpecialistReplyFeather() {
  return (node:ProseNode) => {
    while (textContainers.has(node.type) && !node.data?.hName) {
      const children = node.children ?? [];
      let index = children.length - 1;
      while (index >= 0 && (invisibleTailNodes.has(children[index]!.type) ||
        children[index]!.type === 'text' && !children[index]!.value?.trim())) index--;
      const tail = children[index];
      if (!tail) return;

      if (tail.type === 'text') wrapRevealText(tail);
      if (tail.type === 'lakeRevealText') {
        tail.data!.hProperties!['data-specialist-feather'] = true;
        return;
      }
      if (inlineContainers.has(node.type) && !textContainers.has(tail.type)) {
        children.splice(index + 1, 0, {type:'lakeSpecialistFeather',data:{hName:'lake-specialist-feather'}});
        return;
      }
      node = tail;
    }
  };
}

export function MarkdownReveal({source,active,animateInitial,finishPending,render}: MarkdownRevealOptions & {source: string; render: (paintedThrough?:number)=>ReactNode}) {
  const visible = useSmoothText(source,active,{animateInitial,finishPending});
  // Completion with the same source leaves the parsed text nodes mounted,
  // even if references change and the Markdown needs to be parsed again.
  const packet=useRef({source,paintedThrough:visible.length});
  const paintedThrough=packet.current.source===source?packet.current.paintedThrough:visible.length;
  useLayoutEffect(()=>{packet.current={source,paintedThrough};},[source,paintedThrough]);
  const prose=useMemo(()=>render(paintedThrough<source.length?paintedThrough:undefined),[source,render,paintedThrough]);
  return <VisibleOffset.Provider value={visible.length}>{prose}</VisibleOffset.Provider>;
}

export const markdownRevealComponents = {
  'lake-reveal-text': function RevealText({node}: ExtraProps) {
    const offset = useContext(VisibleOffset);
    const start = node?.properties?.['data-reveal-start'];
    const text = node?.children.map(child=>child.type==='text'?child.value:'').join('')??'';
    const shown = offset === undefined || typeof start !== 'number' ? text : text.slice(0,Math.max(0,offset-start));
    return node?.properties?.['data-specialist-feather'] ? <SpecialistReplyFeatherTail>{shown}</SpecialistReplyFeatherTail> : shown;
  },
  'lake-specialist-feather': SpecialistReplyFeather,
};
