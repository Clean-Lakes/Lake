import {createContext,useContext,type ReactNode} from 'react';
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

const textContainers = new Set(['paragraph','heading','blockquote','list','listItem','strong','emphasis','delete']);
const VisibleOffset = createContext<number | undefined>(undefined);

/** Give frames just the trailing literal text to reveal. The parser owns formatting. */
export function remarkRevealTail() {
  return (tree: ProseNode, file: {value: unknown}) => {
    let node = tree.children?.at(-1);
    let end: number | undefined;
    while (node && !node.data?.hName && textContainers.has(node.type)) {
      end = node.position?.end.offset ?? end;
      node = node.children?.at(-1);
    }
    if (node?.type !== 'text' || !node.value || node.data?.hName) return;
    const value = node.value;
    end = node.position?.end.offset ?? end;
    if (end === undefined || end < value.length) return;
    const start = end - value.length;
    if (String(file.value ?? '').slice(start, end) !== value) return;
    node.type = 'lakeRevealTail';
    node.data = {hName:'lake-reveal-tail', hProperties:{'data-reveal-start':start}};
    node.children = [{type:'text',value}];
    delete node.value;
  };
}

export function MarkdownReveal({source,active,animateInitial,children}: MarkdownRevealOptions & {source: string; children: ReactNode}) {
  const visible = useSmoothText(source,active,animateInitial);
  // The Markdown element is supplied by the parent. A display frame only
  // updates the offset read by its text leaf.
  return <VisibleOffset.Provider value={active ? visible.length : undefined}>{children}</VisibleOffset.Provider>;
}

export const markdownRevealComponents = {
  'lake-reveal-tail': function RevealTail({node}: ExtraProps) {
    const offset = useContext(VisibleOffset);
    const start = node?.properties?.['data-reveal-start'];
    const text = node?.children.map(child=>child.type==='text'?child.value:'').join('')??'';
    return offset === undefined || typeof start !== 'number' ? text : text.slice(0,Math.max(0,offset-start));
  }
};
