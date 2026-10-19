import {useEffect,useRef} from 'react';
import Markdown,{type Components} from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type {FileChange} from './file-changes-model';
import {fileName,linkedFile} from './fileLinks';
import {Glyph} from './Icons';
import {DisclosureSummary} from './DisclosureSummary';

export function FilePreview({file,files,target,hrefFor,onOpen,onClose}:{file:FileChange;files:FileChange[];target:string;hrefFor:(file:FileChange)=>string;onOpen:(file:FileChange)=>void;onClose:()=>void}) {
 const dialog=useRef<HTMLDialogElement>(null);
 useEffect(()=>{const previous=document.activeElement as HTMLElement|null;const node=dialog.current;node?.showModal();return()=>{node?.close();if(previous?.isConnected)previous.focus({preventScroll:true})}},[]);
 useEffect(()=>{const node=dialog.current;if(node){node.scrollTop=0;node.querySelector('button')?.focus({preventScroll:true})}},[file.id]);
 const content=file.deleted?file.before:file.after;
 const markdown=/\.(md|markdown|mdown)$/i.test(file.path)&&!file.deleted;
 const components:Components={
  a:({node,href,children,...props})=>{const linked=linkedFile(files,href??'',file);if(linked)return <a {...props} href={hrefFor(linked)} onClick={event=>{event.preventDefault();onOpen(linked)}}>{children}</a>;return href&&/^https?:\/\//i.test(href)?<a {...props} href={href} target="_blank" rel="noopener noreferrer">{children}</a>:<span>{children}</span>},
  img:({alt})=><span>{alt||'图片'}</span>,
  table:({node,...props})=><div className="markdown-table-scroll"><table {...props}/></div>,
 };
 return <dialog ref={dialog} className="file-preview" aria-label={`文件预览：${fileName(file.path)}`} onCancel={event=>{event.preventDefault();onClose()}}>
  <header className="file-preview-head"><div><h2><Glyph name="document" size={18}/>{fileName(file.path)}</h2><p>{target||'本轮文件'}{file.containerId?` · ${file.containerId}`:''}</p></div><button type="button" className="icon-button" aria-label="关闭文件预览" onClick={onClose}><Glyph name="close" size={18}/></button></header>
  <div className="file-preview-location"><code>{file.path}</code><span>会话中保存的版本{file.deleted?' · 已删除，显示变更前内容':''}</span></div>
  <div className="file-preview-body">{markdown?<><div className="ai-markdown assistant-prose"><Markdown remarkPlugins={[remarkGfm]} skipHtml components={components}>{content}</Markdown></div><details className="file-preview-source"><DisclosureSummary>查看原文</DisclosureSummary><pre>{content||'（空文件）'}</pre></details></>:<pre>{content||'（空文件）'}</pre>}</div>
 </dialog>;
}
