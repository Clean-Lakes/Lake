import {createContext,useContext,useMemo,type ReactNode} from 'react';
import type {ExtraProps} from 'react-markdown';
import {useSmoothText} from './useSmoothText';

export type MarkdownRevealOptions = {active: boolean; animateInitial?: boolean};

type ProseNode = {
  type: string;
  value?: string;
  children?: ProseNode[];
  position?: {end: {offset?: number}};
  data?: {hName?: string; hProperties?: Record<string, unknown>};
};

const textContainers = new Set(['root','paragraph','heading','blockquote','list','listItem','strong','emphasis','delete']);
const VisibleOffset = createContext<number | undefined>(undefined);

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
      node.type='lakeRevealText';
      node.data={hName:'lake-reveal-text',hProperties:{'data-reveal-start':start}};
      node.children=[{type:'text',value}];
      delete node.value;
    }
    visit(tree);
  };
}

export function MarkdownReveal({source,active,animateInitial,render}: MarkdownRevealOptions & {source: string; render: (paintedThrough?:number)=>ReactNode}) {
  const visible = useSmoothText(source,active,animateInitial);
  // Only a real packet or parser input change can replace the parsed tree.
  // Frame updates advance the offset read by its pending literal text leaves.
  const prose=useMemo(()=>render(active?visible.length:undefined),[source,active,render]);
  return <VisibleOffset.Provider value={active ? visible.length : undefined}>{prose}</VisibleOffset.Provider>;
}

export const markdownRevealComponents = {
  'lake-reveal-text': function RevealText({node}: ExtraProps) {
    const offset = useContext(VisibleOffset);
    const start = node?.properties?.['data-reveal-start'];
    const text = node?.children.map(child=>child.type==='text'?child.value:'').join('')??'';
    return offset === undefined || typeof start !== 'number' ? text : text.slice(0,Math.max(0,offset-start));
  }
};
