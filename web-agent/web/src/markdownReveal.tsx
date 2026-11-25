import {createContext,useContext,useEffect,useLayoutEffect,useMemo,useRef,useState,type ReactNode,type RefObject} from 'react';
import type {ExtraProps} from 'react-markdown';
import {isLakeAvatarName,type LakeAvatarName} from './lakeAvatarCatalog';
import {SpecialistReplyCursor,SpecialistReplyCursorTail,SpecialistReplyWaiting} from './SpecialistReplyCursor';
import {useSmoothText} from './useSmoothText';

export type MarkdownRevealOptions = {active: boolean; animateInitial?: boolean; finishPending?: boolean; waitForUpdate?: boolean};

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
export function remarkSpecialistReplyCursor(avatar: LakeAvatarName) {
  return () => (node:ProseNode) => {
    while (textContainers.has(node.type) && !node.data?.hName) {
      const children = node.children ?? [];
      let index = children.length - 1;
      while (index >= 0 && (invisibleTailNodes.has(children[index]!.type) ||
        children[index]!.type === 'text' && !children[index]!.value?.trim())) index--;
      const tail = children[index];
      if (!tail) return;

      if (tail.type === 'text') wrapRevealText(tail);
      if (tail.type === 'lakeRevealText') {
        tail.data!.hProperties!['data-cursor-avatar'] = avatar;
        return;
      }
      if (inlineContainers.has(node.type) && !textContainers.has(tail.type)) {
        children.splice(index + 1, 0, {type:'lakeSpecialistCursor',data:{hName:'lake-specialist-cursor',hProperties:{'data-cursor-avatar':avatar}}});
        return;
      }
      node = tail;
    }
  };
}

const sweepProperties = ['--reply-wait-angle','--reply-wait-band','--reply-wait-width','--reply-wait-x','--reply-wait-y','--reply-wait-duration'] as const;

function useWaitingSweep(surface: RefObject<HTMLDivElement|null>, waiting: boolean) {
  useLayoutEffect(() => {
    const element = surface.current;
    if (!waiting || !element) return;

    const measure = () => {
      const {clientWidth:width,clientHeight:height} = element;
      if (!width || !height) {
        element.removeAttribute('data-reply-waiting');
        return;
      }

      const lineHeight = parseFloat(getComputedStyle(element).lineHeight) || 26;
      const singleLine = height <= lineHeight * 1.45;
      let sweepWidth = width;
      if (singleLine) {
        const range = document.createRange();
        range.selectNodeContents(element.firstElementChild ?? element);
        sweepWidth = Math.min(width,range.getBoundingClientRect().width) || width;
      }
      // Tilt the band by less than one line across the width, so it moves
      // left to right within each line before reaching the next one.
      const skew = lineHeight * .8;
      const angle = singleLine ? 90 : 180 - Math.atan2(skew,width) * 180 / Math.PI;
      const band = singleLine ? Math.min(72,Math.max(18,sweepWidth * .12)) : lineHeight * .38;
      const x = singleLine ? sweepWidth / 2 + band + 1 : 0;
      const y = singleLine ? 0 : height / 2 + skew / 2 + band + 1;
      const duration = Math.min(10,Math.max(3.6,height / lineHeight * .48));
      const values = [`${angle}deg`,`${band}px`,`${sweepWidth}px`,`${x}px`,`${y}px`,`${duration}s`];
      sweepProperties.forEach((property,index) => element.style.setProperty(property,values[index]!));
      element.setAttribute('data-reply-waiting','');
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => {
      observer.disconnect();
      element.removeAttribute('data-reply-waiting');
      sweepProperties.forEach(property => element.style.removeProperty(property));
    };
  },[surface,waiting]);
}

export function MarkdownReveal({source,active,animateInitial,finishPending,waitForUpdate,waitingSurface,render}: MarkdownRevealOptions & {source: string; waitingSurface: RefObject<HTMLDivElement|null>; render: (paintedThrough?:number)=>ReactNode}) {
  const visible = useSmoothText(source,active,{animateInitial,finishPending});
  const caughtUp = !!waitForUpdate && visible === source;
  const waitTarget = useMemo(() => caughtUp ? {source} : undefined,[caughtUp,source]);
  const [waited,setWaited] = useState<typeof waitTarget>();
  useEffect(() => {
    if (!waitTarget) return;
    // Let brief gaps pass before starting the waiting motion.
    const timer = window.setTimeout(() => setWaited(waitTarget),550);
    return () => window.clearTimeout(timer);
  }, [waitTarget]);
  const waiting = !!waitTarget && waited === waitTarget;
  useWaitingSweep(waitingSurface,waiting);
  // Completion with the same source leaves the parsed text nodes mounted,
  // even if references change and the Markdown needs to be parsed again.
  const packet=useRef({source,paintedThrough:visible.length});
  const paintedThrough=packet.current.source===source?packet.current.paintedThrough:visible.length;
  useLayoutEffect(()=>{packet.current={source,paintedThrough};},[source,paintedThrough]);
  const prose=useMemo(()=>render(paintedThrough<source.length?paintedThrough:undefined),[source,render,paintedThrough]);
  return <VisibleOffset.Provider value={visible.length}>
    <SpecialistReplyWaiting.Provider value={waiting}>{prose}</SpecialistReplyWaiting.Provider>
  </VisibleOffset.Provider>;
}

function cursorAvatar(node: ExtraProps['node']) {
  const value = node?.properties?.['data-cursor-avatar'];
  return typeof value === 'string' && isLakeAvatarName(value) ? value : undefined;
}

export const markdownRevealComponents = {
  'lake-reveal-text': function RevealText({node}: ExtraProps) {
    const offset = useContext(VisibleOffset);
    const start = node?.properties?.['data-reveal-start'];
    const text = node?.children.map(child=>child.type==='text'?child.value:'').join('')??'';
    const shown = offset === undefined || typeof start !== 'number' ? text : text.slice(0,Math.max(0,offset-start));
    const avatar = cursorAvatar(node);
    return avatar ? <SpecialistReplyCursorTail avatar={avatar}>{shown}</SpecialistReplyCursorTail> : shown;
  },
  'lake-specialist-cursor': function InlineCursor({node}: ExtraProps) {
    const avatar = cursorAvatar(node);
    return avatar ? <SpecialistReplyCursor avatar={avatar}/> : null;
  },
};
