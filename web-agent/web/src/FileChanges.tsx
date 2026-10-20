import { memo, useId, useLayoutEffect, useRef, useState } from "react";
import type { AICard, Resource } from "../../shared/contracts";
import { sameCard } from "./cardEquality";
import { summarizeFileChanges, type LineDelta } from "./file-changes-model";
import {FilePreview} from './FilePreview';
import {fileName} from './fileLinks';
import {Glyph} from './Icons';

function Delta({ delta }: { delta: LineDelta | null }) {
  return delta ? <><span className="file-change-added" aria-label={`增加 ${delta.added} 行`}>+{delta.added}</span><span className="file-change-removed" aria-label={`删除 ${delta.removed} 行`}>-{delta.removed}</span></> : <small>行数统计暂不可用</small>;
}
export const FileChanges = memo(function FileChanges({ cards, resources, partial = false, live = false, deferUntilEnd = false }: { cards: AICard[]; resources: Resource[]; partial?: boolean; live?: boolean; deferUntilEnd?: boolean }) {
  const { files, delta } = summarizeFileChanges(cards);
  const scope=useId(),[selected,setSelected]=useState<string|null>(null);
  const observedLive=useRef(live),revealed=useRef(false);
  const [arrive,setArrive]=useState(false);
  useLayoutEffect(()=>{
    if(live){observedLive.current=true;return;}
    if(!files.length||revealed.current)return;
    revealed.current=true;
    if(deferUntilEnd&&observedLive.current)setArrive(true);
  },[live,files.length,deferUntilEnd]);
  const idFor=(file:typeof files[number])=>`lake-file-${scope}-${files.indexOf(file)}`;
  const hrefFor=(file:typeof files[number])=>`#${encodeURIComponent(idFor(file))}`;
  const targetFor=(file:typeof files[number])=>resources.find(resource=>resource.id===file.assetRef)?.name||file.target;
  const preview=files.find(file=>file.id===selected);
  if (!files.length || live && deferUntilEnd) return null;
  return <div className={`turn-files${arrive?" reply-arrival":""}`}><nav className="turn-file-links" aria-label="本轮文件">{files.filter(file=>!file.deleted).map(file=><a key={file.id} href={hrefFor(file)} title={`${targetFor(file)||'本轮文件'} · ${file.path}`} onClick={event=>{event.preventDefault();setSelected(file.id)}}><Glyph name="document" size={14}/><span>{fileName(file.path)}</span>{files.filter(other=>fileName(other.path)===fileName(file.path)).length>1&&<small>{targetFor(file)||file.path}{file.containerId?` · ${file.containerId}`:''}</small>}</a>)}</nav><details className="file-changes">
    <summary className="file-changes-badge"><Glyph name="document" size={14}/><span className="file-changes-label">{files.length} 个文件已更改{partial ? "（部分记录）" : ""}</span><span className="file-changes-delta"><Delta delta={delta}/></span><Glyph name="next" size={13} className="file-changes-chevron"/></summary>
    <div className="file-changes-list">{files.map(file => {
      const target = resources.find(resource => resource.id === file.assetRef)?.name || file.target;
      return <details className="file-change" id={idFor(file)} key={file.id}>
        <summary><span className="file-change-path">{target && <small>{target}{file.containerId ? ` · ${file.containerId}` : ""}</small>}<a href={hrefFor(file)} onClick={event=>{event.preventDefault();event.stopPropagation();setSelected(file.id)}}>{file.path}</a></span><span className="file-change-kind">{file.deleted ? "已删除" : !file.existed ? "新建" : "修改"}</span><Delta delta={file.delta}/></summary>
        <div className="ai-diff-columns"><div><small>变更前</small><pre>{file.before || (file.existed ? "（空文件）" : "（不存在）")}</pre></div><div><small>变更后</small><pre>{file.after || (file.deleted ? "（已删除）" : "（空文件）")}</pre></div></div>
      </details>;
    })}</div>
  </details>{preview&&<FilePreview file={preview} files={files} target={targetFor(preview)} hrefFor={hrefFor} onOpen={file=>setSelected(file.id)} onClose={()=>setSelected(null)}/>}</div>;
}, (previous, next) => previous.partial === next.partial && previous.live === next.live && previous.deferUntilEnd === next.deferUntilEnd && previous.cards.length === next.cards.length && previous.cards.every((card, index) => sameCard(card, next.cards[index]!)) && previous.resources.length === next.resources.length && previous.resources.every((resource, index) => resource.id === next.resources[index]?.id && resource.name === next.resources[index]?.name));
