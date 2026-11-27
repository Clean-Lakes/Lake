import { useRef, useState } from "react";
import type { GatewayApprovalRequest } from "../../shared/contracts";
import { api, ApiRequestError, readableError } from "./api";
import { DeferredDisclosure, DisclosureSummary } from "./DisclosureSummary";
import { Glyph } from "./Icons";
import { SuperRoleAvatar } from "./SuperRoleAvatar";
import "./pilotGatewayApprovals.css";

const inlineResourceLimit = 3;

function ApprovalResourceList({ resourceIds, resourceNames }: Pick<GatewayApprovalRequest, "resourceIds" | "resourceNames">) {
  return (
    <ul
      className="pilot-gateway-approval-resources"
      role="list"
      aria-label="授权资源"
      tabIndex={resourceNames.length > inlineResourceLimit ? 0 : undefined}
    >
      {resourceNames.map((name, index) => (
        <li key={resourceIds[index] ?? index} className="pilot-gateway-approval-resource">{name}</li>
      ))}
    </ul>
  );
}

function ApprovalCard({
  approval,
  compact,
  busy,
  decisionsDisabled,
  onDecision,
}: {
  approval: GatewayApprovalRequest;
  compact: boolean;
  busy: boolean;
  decisionsDisabled: boolean;
  onDecision: (approve: boolean, reason?: string) => Promise<boolean>;
}) {
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");

  async function submit(approve: boolean) {
    if (await onDecision(approve, approve ? undefined : reason.trim() || undefined)) {
      setRejecting(false);
      setReason("");
    }
  }

  const fieldCount = approval.fields.length;
  const gridClass = fieldCount === 1 ? "cols-1" : fieldCount === 3 ? "cols-3" : "cols-2";
  const resourceCount = approval.resourceNames.length;
  const resourceList = resourceCount > 0
    ? <ApprovalResourceList resourceIds={approval.resourceIds} resourceNames={approval.resourceNames} />
    : null;
  const status = (
    <span className="pilot-gateway-approval-state" data-status={approval.status}>
      {approval.status === "pending" ? "待审批" : approval.status === "approved" ? "已同意" : "已拒绝"}
    </span>
  );

  const details = (
    <div className="pilot-gateway-approval-detail">
      <p className="pilot-gateway-approval-ask">{approval.askText}</p>

      <div className="pilot-gateway-approval-card">
        <header className="pilot-gateway-approval-head">
          {!compact && <h3>{approval.title}</h3>}
          <p>{approval.summary}</p>
        </header>

        {resourceCount > inlineResourceLimit ? (
          <DeferredDisclosure
            className="pilot-gateway-approval-resource-details"
            summary={`授权资源（${resourceCount} 项）`}
          >
            {resourceList}
          </DeferredDisclosure>
        ) : resourceList}

        {approval.fields.length > 0 && (
          <dl className={`pilot-gateway-approval-fields ${gridClass}`}>
            {approval.fields.map((field, index) => (
              <div key={`${field.label}:${index}`}>
                <dt>{field.label}</dt>
                <dd>{field.value}</dd>
              </div>
            ))}
          </dl>
        )}

        <details className="pilot-gateway-approval-raw">
          <DisclosureSummary>查看原始请求</DisclosureSummary>
          <pre>{approval.rawRequest}</pre>
        </details>

        {approval.status === "pending" ? (
          rejecting ? (
            <form
              className="pilot-gateway-approval-reject"
              onSubmit={event => {
                event.preventDefault();
                void submit(false);
              }}
            >
              <label htmlFor={`reject-reason-${approval.id}`} className="visually-hidden">
                拒绝原因（可选）
              </label>
              <input
                id={`reject-reason-${approval.id}`}
                type="text"
                maxLength={500}
                value={reason}
                disabled={decisionsDisabled}
                placeholder="可选：填写拒绝原因，将同步发回外部请求方"
                onChange={event => setReason(event.target.value)}
                autoFocus
              />
              <div className="pilot-gateway-approval-actions">
                <button
                  type="button"
                  className="button secondary"
                  disabled={busy}
                  onClick={() => {
                    setRejecting(false);
                    setReason("");
                  }}
                >
                  取消
                </button>
                <button type="submit" className="button danger" disabled={decisionsDisabled}>
                  {busy ? "处理中…" : "确认拒绝"}
                </button>
              </div>
            </form>
          ) : (
            <footer className="pilot-gateway-approval-footer">
              <small>确认后将由「{approval.roleName}」创建任务并执行</small>
              <div className="pilot-gateway-approval-actions">
                <button
                  type="button"
                  className="button secondary"
                  disabled={decisionsDisabled}
                  onClick={() => setRejecting(true)}
                >
                  拒绝
                </button>
                <button
                  type="button"
                  className="button primary"
                  disabled={decisionsDisabled}
                  onClick={() => void submit(true)}
                >
                  <Glyph name="check" size={14} />
                  <span>{busy ? "处理中…" : "同意"}</span>
                </button>
              </div>
            </footer>
          )
        ) : (
          <footer className="pilot-gateway-approval-footer is-settled">
            <small>
              {approval.status === "approved"
                ? "已同意，专员将处理该请求并同步进度。"
                : `已拒绝该外部请求${approval.decisionReason ? `（原因：${approval.decisionReason}）` : ""}，已通知请求方。`}
            </small>
          </footer>
        )}
      </div>
    </div>
  );

  return (
    <article className="pilot-gateway-approval" aria-label={`${approval.roleName}的外部请求审批`}>
      {compact ? (
        <DeferredDisclosure
          className="pilot-gateway-approval-item"
          summaryClassName="pilot-gateway-approval-toggle"
          summary={
            <>
              <span className="pilot-gateway-approval-caption">
                <strong>{approval.title}</strong>
                <small>{approval.roleName} · 来自 {approval.requester}</small>
              </span>
              {status}
            </>
          }
        >
          {details}
        </DeferredDisclosure>
      ) : (
        <>
          <div className="pilot-gateway-approval-author">
            <span className="pilot-gateway-approval-avatar" aria-hidden="true">
              <SuperRoleAvatar name={approval.roleName} roleId={approval.roleId}
                avatarId={approval.avatarId} motion="still" size={24} />
            </span>
            <div className="pilot-gateway-approval-meta">
              <strong>{approval.roleName}</strong>
              <span className="pilot-gateway-approval-source">来自 {approval.requester}</span>
              {status}
            </div>
          </div>
          {details}
        </>
      )}
    </article>
  );
}

export function PilotGatewayApprovals({
  approvals,
  connected,
  onDecided,
}: {
  approvals?: GatewayApprovalRequest[];
  connected: boolean;
  onDecided: () => Promise<unknown>;
}) {
  const submitting = useRef(false);
  const [deciding, setDeciding] = useState<string | null>(null);
  const [error, setError] = useState("");
  if (!approvals?.length) return null;
  const pending = approvals.filter(approval => approval.status === "pending");
  const decisionsDisabled = !connected || deciding !== null;

  async function decide(items: GatewayApprovalRequest[], approve: boolean, reason?: string) {
    if (!connected || submitting.current || !items.length) return false;
    const first = items[0]!;
    submitting.current = true;
    setDeciding(items.length === 1 ? first.id : "all");
    setError("");
    let applied = false;
    try {
      if (items.length === 1) {
        await api.decideGatewayApproval(first.projectId, first.id, { approve, ...(reason && { reason }) });
      } else {
        await api.decideGatewayApprovals(first.projectId, { approvalIds: items.map(item => item.id), approve });
      }
      applied = true;
      await onDecided();
    } catch (cause) {
      const message = readableError(cause);
      setError(applied ? `审批已提交，刷新失败。${message}` : message);
      if (!applied && cause instanceof ApiRequestError && cause.status === 409) {
        await onDecided().catch(() => {});
      }
    } finally {
      submitting.current = false;
      setDeciding(null);
    }
    return applied;
  }

  return (
    <section className="pilot-gateway-approvals" aria-label="外部 MCP 任务审批">
      {pending.length > 1 && (
        <div className="pilot-gateway-approval-toolbar">
          <strong>外部 MCP 审批</strong>
          <button type="button" className="button primary" disabled={decisionsDisabled} onClick={() => void decide(pending, true)}>
            <Glyph name="check" size={14} />
            <span>{deciding === "all" ? "处理中…" : `全部同意（${pending.length}）`}</span>
          </button>
        </div>
      )}
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="pilot-gateway-approval-list" role="region" aria-label="外部 MCP 审批请求列表" tabIndex={0}>
        {approvals.map(approval => (
          <ApprovalCard
            key={approval.id}
            approval={approval}
            compact={approvals.length > 1}
            busy={deciding === approval.id}
            decisionsDisabled={decisionsDisabled}
            onDecision={(approve, reason) => decide([approval], approve, reason)}
          />
        ))}
      </div>
    </section>
  );
}
