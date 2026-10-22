import {createContext, memo, useContext, useEffect, useMemo, useRef, useState, type ReactNode} from 'react';
import Markdown, {type Components} from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type {AICard, AgentRun, Resource, WorkspaceTag} from '../../shared/contracts';
import {remarkAssistantProse} from './assistantProse';
import {remarkConversationTags, conversationTagSignature} from './conversationTags';
import {objectCatalog, objectMatches, remarkObjectReferences, type ObjectCatalog, type ObjectReference} from './objectReferences';
import {summarizeFileChanges, type FileChange} from './file-changes-model';
import {FilePreview} from './FilePreview';
import {Glyph, ResourceIcon} from './Icons';
import {MarkdownCodeBlock} from './MarkdownCodeBlock';
import {remarkReplyInfo} from './replyInfo';
import {replyInfoComponents, ReplyInfoSpan} from './ReplyInfoElements';

const emptyCatalog = objectCatalog();
const References = createContext<{catalog: ObjectCatalog; open?: (reference: ObjectReference) => void}>({catalog: emptyCatalog});

function ReferenceDetails({reference, onClose}: {reference: ObjectReference; onClose: () => void}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.showModal();
    return () => { dialog.current?.close(); if (previous?.isConnected) previous.focus({preventScroll: true}); };
  }, []);
  const resource = reference.resource;
  // Only these display fields are allowed. Never serialize settings or render
  // credentials, connection strings, task arguments or arbitrary tool output.
  const host = resource?.ssh?.host ?? resource?.settings?.host;
  const port = resource?.ssh?.port ?? resource?.settings?.port;
  const rows = resource ? [
    ['类型', reference.description.split(' · ')[0]],
    ['地址', typeof host === 'string' ? host : ''],
    ['端口', typeof port === 'number' || typeof port === 'string' ? String(port) : ''],
    ['用户', resource.ssh?.username ?? ''],
  ] : reference.task ? [['任务', reference.task.name ?? ''], ['状态', reference.task.status], ['说明', reference.task.task]] : [];
  return <dialog ref={dialog} className="object-reference-details" aria-label={`对象详情：${resource?.name ?? reference.label}`} onCancel={event => {event.preventDefault(); onClose();}} onClick={event => {if (event.target === event.currentTarget) {const rect = event.currentTarget.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) onClose();}}}>
    <header><span><Glyph name={reference.icon} size={17}/>{resource?.name ?? reference.label}</span><button type="button" className="icon-button" aria-label="关闭对象详情" onClick={onClose}><Glyph name="close" size={16}/></button></header>
    <dl>{rows.filter(([, value]) => value).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
  </dialog>;
}

export function ObjectReferencesProvider({resources, files, tasks, children}: {resources?: readonly Resource[]; files?: readonly FileChange[]; tasks?: readonly AgentRun[]; children: ReactNode}) {
  const parent = useContext(References);
  const catalog = useMemo(() => {
    const own = objectCatalog(resources, files, tasks);
    const aliases = new Map(parent.catalog.aliases);
    // A nested provider adds turn-scoped files. Shared aliases across objects
    // remain ambiguous rather than silently selecting the most recent target.
    for (const [name, reference] of own.aliases) {
      const previous = aliases.get(name);
      aliases.set(name, previous === undefined || previous?.key === reference?.key ? reference : null);
    }
    return {aliases};
  }, [parent.catalog, resources, files, tasks]);
  const [selected, setSelected] = useState<ObjectReference | null>(null);
  const value = useMemo(() => ({catalog, open: setSelected}), [catalog]);
  return <References.Provider value={value}>{children}{selected?.file ? <FilePreview file={selected.file} files={[...files ?? []]} target={selected.file.target || '会话文件'} hrefFor={() => '#'} onOpen={file => setSelected({...selected, file, label: file.path})} onClose={() => setSelected(null)}/> : selected && <ReferenceDetails reference={selected} onClose={() => setSelected(null)}/>}</References.Provider>;
}

export function ReplyReferenceScope({cards, children}: {cards: AICard[]; children: ReactNode}) {
  const files = useMemo(() => summarizeFileChanges(cards).files, [cards]);
  return <ObjectReferencesProvider files={files}>{children}</ObjectReferencesProvider>;
}

function InlineReference({reference}: {reference: ObjectReference}) {
  const {open} = useContext(References);
  const inspectable = !!open && !!(reference.resource || reference.file || reference.task);
  const className = `object-reference${reference.resource ? ' message-reference-token' : ''}`;
  const content = <>{reference.resource ? <ResourceIcon kind={reference.resource.kind} size={12}/> : <Glyph name={reference.icon} size={12}/>}<span className="object-reference-label">{reference.label}</span></>;
  return inspectable ? <button type="button" className={className} data-object-kind={reference.kind} data-object-id={reference.key} title={reference.description} aria-label={`查看${reference.description}`} onClick={() => open(reference)}>{content}</button> : <span className={className} data-object-kind={reference.kind} title={reference.description}>{content}</span>;
}

// Keep renderer identity stable while streamed text and snapshots are updated.
const components: Components = {
  ...replyInfoComponents,
  pre: MarkdownCodeBlock,
  table: ({node, ...props}) => <div className="markdown-table-scroll"><table {...props}/></div>,
  span: function ReferenceSpan({node, children, ...props}) {
    const {catalog} = useContext(References);
    const key = node?.properties?.['data-object-key'];
    const label = node?.properties?.['data-object-label'];
    if (typeof key === 'string' && typeof label === 'string') {
      const reference = objectMatches(label, catalog).find(match => match.start === 0 && match.end === label.length && match.reference.key === key)?.reference;
      return reference ? <InlineReference reference={reference}/> : <>{children}</>;
    }
    return <ReplyInfoSpan node={node} {...props}>{children}</ReplyInfoSpan>;
  },
};

export const AssistantMarkdown = memo(function AssistantMarkdown({children, tags = [], className = ''}: {children: string; tags?: readonly WorkspaceTag[]; className?: string}) {
  const {catalog} = useContext(References);
  const signature = conversationTagSignature(tags);
  const decorateTags = useMemo(() => remarkConversationTags(tags), [signature]);
  const decorateObjects = useMemo(() => remarkObjectReferences(catalog), [catalog]);
  return <div className={`ai-markdown assistant-prose${className ? ` ${className}` : ''}`}><Markdown remarkPlugins={[remarkGfm, remarkAssistantProse, remarkReplyInfo, decorateTags, decorateObjects]} components={components} skipHtml>{children}</Markdown></div>;
});
