import { memo } from "react";
import type { AICard, Resource } from "../../shared/contracts";
import { sameCard } from "./cardEquality";
import { summarizeFileChanges, type LineDelta } from "./file-changes-model";

function Delta({ delta }: { delta: LineDelta | null }) {
  return delta ? <><span className="file-change-added" aria-label={`增加 ${delta.added} 行`}>+{delta.added}</span><span className="file-change-removed" aria-label={`删除 ${delta.removed} 行`}>-{delta.removed}</span></> : <small>行数统计暂不可用</small>;
}
export const FileChanges = memo(function FileChanges({ cards, resources, partial = false }: { cards: AICard[]; resources: Resource[]; partial?: boolean }) {
  const { files, delta } = summarizeFileChanges(cards);
  if (!files.length) return null;
  return <details className="file-changes">
    <summary className="file-changes-badge"><span>{files.length} 个文件已更改{partial ? "（部分记录）" : ""}</span><Delta delta={delta}/></summary>
    <div className="file-changes-list">{files.map(file => {
      const target = resources.find(resource => resource.id === file.assetRef)?.name || file.target;
      return <details className="file-change" key={file.id}>
        <summary><span className="file-change-path">{target && <small>{target}{file.containerId ? ` · ${file.containerId}` : ""}</small>}<span>{file.path}</span></span><span className="file-change-kind">{file.deleted ? "已删除" : !file.existed ? "新建" : "修改"}</span><Delta delta={file.delta}/></summary>
        <div className="ai-diff-columns"><div><small>变更前</small><pre>{file.before || (file.existed ? "（空文件）" : "（不存在）")}</pre></div><div><small>变更后</small><pre>{file.after || (file.deleted ? "（已删除）" : "（空文件）")}</pre></div></div>
      </details>;
    })}</div>
  </details>;
}, (previous, next) => previous.partial === next.partial && previous.cards.length === next.cards.length && previous.cards.every((card, index) => sameCard(card, next.cards[index]!)) && previous.resources.length === next.resources.length && previous.resources.every((resource, index) => resource.id === next.resources[index]?.id && resource.name === next.resources[index]?.name));
