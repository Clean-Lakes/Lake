import {createContext,memo,useContext,useLayoutEffect,useRef,type CSSProperties} from 'react';
import {avatarPaintStyle,lakeAvatarArtwork,type AvatarPartName} from './lakeAvatarArtwork';
import {lakeAvatarDefinition,type LakeAvatarFamily,type LakeAvatarName} from './lakeAvatarCatalog';
import {lastGrapheme,trailingGraphemeStart} from './textReveal';
import {usePageVisible} from './usePageVisible';

const familyParts: Record<LakeAvatarFamily, AvatarPartName> = {
  heron: 'head', otter: 'tail', turtle: 'tail', kingfisher: 'wing',
  dragonfly: 'wing', duck: 'wing', fish: 'tail', lotus: 'wing',
};

const characteristicParts: Partial<Record<LakeAvatarName, AvatarPartName>> = {
  capybara: 'head', hippo: 'head', seal: 'fore', 'sea-lion': 'fore',
  turtle: 'shell', softshell: 'shell', frog: 'head', 'tree-frog': 'head', toad: 'head',
  crab: 'fore', lobster: 'fore', 'water-snake': 'shell',
  bee: 'shell', firefly: 'shell', beetle: 'shell', ladybug: 'shell',
};

const cursorViewBoxes = new Map<LakeAvatarName, string>();

function AvatarCursorPart({avatar}: {avatar: LakeAvatarName}) {
  const svg = useRef<SVGSVGElement>(null);
  const {family} = lakeAvatarDefinition(avatar);
  const artwork = lakeAvatarArtwork[avatar];
  const partName = characteristicParts[avatar] ?? familyParts[family];
  const part = artwork.parts.find(part => part.name === partName) ?? artwork.parts[0]!;

  useLayoutEffect(() => {
    const node = svg.current;
    if (!node) return;
    // The avatar paths share a 64px canvas. Fit just the selected part once
    // per species so a small tail can fill the mark without repeated layout.
    let viewBox = cursorViewBoxes.get(avatar);
    if (!viewBox) {
      const bounds = node.getBBox?.();
      if (!bounds || !(bounds.width || bounds.height)) return;
      const padding = Math.max(1.5, Math.max(bounds.width, bounds.height) * .07);
      viewBox = `${bounds.x-padding} ${bounds.y-padding} ${bounds.width+2*padding} ${bounds.height+2*padding}`;
      cursorViewBoxes.set(avatar, viewBox);
    }
    if (node.getAttribute('viewBox') !== viewBox) node.setAttribute('viewBox', viewBox);
  }, [avatar]);

  return <svg ref={svg} className="specialist-cursor-artwork" data-family={family} data-part={part.name}
    viewBox={cursorViewBoxes.get(avatar) ?? '0 0 64 64'} style={avatarPaintStyle(artwork.palette) as CSSProperties} aria-hidden="true" focusable="false">
    {part.shapes.map((shape, i) => {
      const paint = `var(--avatar-${shape.tone})`;
      return <path key={i} d={shape.d} fill={shape.line ? 'none' : paint} stroke={shape.line ? paint : undefined}
        strokeWidth={shape.line ? shape.width : undefined} opacity={shape.opacity} strokeLinecap="round" strokeLinejoin="round"/>;
    })}
    {part.eyes?.map(([x,y]) => <ellipse key={`${x},${y}`} cx={x} cy={y} rx="1.15" ry="1.35" fill="var(--avatar-eye)"/>)}
  </svg>;
}

export function specialistInterimText(text: string) {
  return text.replace(/(?:。|(?<![.\d])\.)(?=\s*$)/u, '');
}

// Undefined leaves ordinary specialist cursors outside the waiting presentation.
export const SpecialistReplyWaiting = createContext<boolean|undefined>(undefined);

export const SpecialistReplyCursor = memo(function SpecialistReplyCursor({avatar}: {avatar: LakeAvatarName}) {
  const visible = usePageVisible();
  const waiting = useContext(SpecialistReplyWaiting);
  let mark;
  switch (avatar) {
    case 'rabbit':
      mark = <span className="specialist-cursor-rabbit">
        <span className="specialist-cursor-ear"/><span className="specialist-cursor-ear"/>
      </span>;
      break;
    case 'kingfisher':
      mark = <span className="specialist-cursor-feather">
        <span className="specialist-cursor-plume"/><span className="specialist-cursor-shaft"/>
      </span>;
      break;
    case 'owl':
      mark = <span className="specialist-cursor-eyes"/>;
      break;
    default:
      mark = <AvatarCursorPart key={avatar} avatar={avatar}/>;
  }
  return <span className="specialist-reply-cursor" data-cursor-avatar={avatar} data-waiting={waiting || undefined} data-paused={!visible || undefined} aria-hidden="true">{mark}</span>;
});

export function SpecialistReplyCursorTail({avatar,children}: {avatar: LakeAvatarName;children: string}) {
  const waiting = useContext(SpecialistReplyWaiting);
  const text = children.trimEnd();
  const last = lastGrapheme(text);
  if (!last) return children;
  const start = waiting===undefined ? last.index : trailingGraphemeStart(text,8);
  const tail = <span className="specialist-reply-cursor-tail">{last.segment}<SpecialistReplyCursor avatar={avatar}/></span>;
  return <>{text.slice(0,start)}{waiting===undefined?tail:
    <span className="specialist-reply-wait-text" data-waiting={waiting||undefined}>{text.slice(start,last.index)}{tail}</span>
  }{children.slice(text.length)}</>;
}
