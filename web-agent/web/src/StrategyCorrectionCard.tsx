import type {AICard} from '../../shared/contracts';
import {DisclosureSummary} from './DisclosureSummary';

export type OnlineCorrectionReport={schemaVersion:number;id:string;taskId?:string;turnId:string;arm:string;modelRef:string;globalEpoch:number;projectEpoch:number;budget:{maxRevisions:number;maxOptimizationRequests:number;maxAdditionalTokens:number};stopReason?:string;recovered:boolean;openChecks?:unknown[];noProgress:number;requests:number;tokensCharged:number;usageUnknown:boolean;selectedAssets:{assetId:string;revision:number;contentHash:string}[];observations:{callId:string;tool:string;class:string;success:boolean;trustedReadOnly:boolean;evidenceHash:string;checkHash:string;at:string}[];revisions:{sourceId:string;refutedHypothesis:string;changes:string;expectedInformation:string;stopCondition:string;tool:string;arguments:string;callId?:string;progress:boolean}[]};
const reasons:Record<string,string>={completed:'原失败检查已取得结果',budget_exhausted:'纠错额度已耗尽',no_progress:'连续未确认进展',permission_blocked:'权限受限',target_ambiguous:'目标需要确认',capability_missing:'检查能力不可用',awaiting_reconciliation:'操作结果待核实',awaiting_user:'等待明确继续或新任务',cancelled:'用户已停止',failed:'纠错已停止'};

export function StrategyCorrectionCard({card}:{card:AICard}){
 const r=card.data as OnlineCorrectionReport|undefined;
 if(!r||r.schemaVersion!==1||!Array.isArray(r.observations)||!Array.isArray(r.revisions))return null;
 const fixed=r.revisions.filter(p=>p.progress).length;
 return <details className="ai-operation strategy-correction-card"><DisclosureSummary><span>只读纠错 · {reasons[r.stopReason||'']||'有界检查中'}</span></DisclosureSummary><div className="strategy-correction-body">
 <p>修订 {r.revisions.length}/{r.budget.maxRevisions} · 确认进展 {fixed} 次 · 连续无进展 {r.noProgress} 次 · 未闭合检查 {r.openChecks?.length??0} 项</p><p>附加模型请求 {r.requests}/{r.budget.maxOptimizationRequests} · 计入 token {r.tokensCharged.toLocaleString()}/{r.budget.maxAdditionalTokens.toLocaleString()}{r.usageUnknown?'（含保守预留）':''}</p>
 <p className="settings-note">这是实际观察记录；原检查取得结果不代表整个任务已恢复。不同任务、模型或策略版本的计数不能证明纠错收益。</p>
 <details><DisclosureSummary>任务与版本</DisclosureSummary><dl><dt>任务</dt><dd>{r.taskId||r.turnId}</dd><dt>实验臂</dt><dd>{r.arm==='assets_with_correction'?'资产 + 只读纠错':r.arm}</dd><dt>模型引用</dt><dd>{r.modelRef}</dd><dt>设置序号（全局 / 项目）</dt><dd>{r.globalEpoch} / {r.projectEpoch}</dd></dl>{r.selectedAssets?.length?r.selectedAssets.map(a=><p key={a.assetId}><code>{a.assetId}@{a.revision}</code> · <code>{a.contentHash}</code></p>):<p>本轮未应用用户策略资产</p>}</details>
 <details><DisclosureSummary>失败来源与观察（{r.observations.length}）</DisclosureSummary>{r.observations.map((o,i)=><div key={`${o.callId}-${i}`}><p><code>{o.callId}</code> · {o.tool} · {o.success?'取得结果':o.class} · {o.trustedReadOnly?'可信只读':'未证明只读'}</p><p className="settings-note">证据 hash：{o.evidenceHash}<br/>检查 hash：{o.checkHash}</p></div>)}</details>
 {r.revisions.map((p,i)=><details key={i}><DisclosureSummary>修订 {i+1} · {p.progress?'原检查缺口已关闭':'尚未确认进展'}</DisclosureSummary><dl><dt>来源调用</dt><dd>{p.sourceId}</dd><dt>被否定假设</dt><dd>{p.refutedHypothesis}</dd><dt>实际修改</dt><dd>{p.changes}</dd><dt>预期信息</dt><dd>{p.expectedInformation}</dd><dt>停止条件</dt><dd>{p.stopCondition}</dd></dl><pre>{p.tool}{'\n'}{p.arguments}</pre></details>)}
 </div></details>;
}
