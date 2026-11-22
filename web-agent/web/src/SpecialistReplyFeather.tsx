import {lastGrapheme} from './textReveal';
import {usePageVisible} from './usePageVisible';

export function specialistInterimText(text: string) {
  return text.replace(/(?:。|(?<![.\d])\.)(?=\s*$)/u, '');
}

export function SpecialistReplyFeather() {
  const visible = usePageVisible();
  return <span className="specialist-reply-feather" data-paused={!visible || undefined} aria-hidden="true">
    <span className="specialist-reply-feather-mark">
      <span className="specialist-reply-feather-plume"/>
      <span className="specialist-reply-feather-quill"/>
    </span>
  </span>;
}

export function SpecialistReplyFeatherTail({children}: {children: string}) {
  const end = children.trimEnd().length;
  const last = lastGrapheme(children.slice(0, end));
  if (!last) return children;

  return <>{children.slice(0, last.index)}<span className="specialist-reply-feather-tail">{last.segment}<SpecialistReplyFeather/></span>{children.slice(end)}</>;
}
