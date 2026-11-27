import { useState } from "react";
import type { GatewayApprovalRequest } from "../../shared/contracts";
import { api, readableError } from "./api";
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
  connected,
  onDecided,
}: {
  approval: GatewayApprovalRequest;
  connected: boolean;
  onDecided: () => Promise<unknown>;
}) {
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(approve: boolean) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await api.decideGatewayApproval(approval.projectId, approval.id, {
        approve,
        ...(!approve && reason.trim() ? { reason: reason.trim() } : {}),
      });
      setRejecting(false);
      setReason("");
      await onDecided();
    } catch (cause) {
      setError(readableError(cause));
    } finally {
      setBusy(false);
    }
  }

  const fieldCount = approval.fields.length;
  const gridClass = fieldCount === 1 ? "cols-1" : fieldCount === 3 ? "cols-3" : "cols-2";
  const resourceCount = approval.resourceNames.length;
  const resourceList = resourceCount > 0
    ? <ApprovalResourceList resourceIds={approval.resourceIds} resourceNames={approval.resourceNames} />
    : null;

  return (
    <article className="pilot-gateway-approval" aria-label={`${approval.roleName}的外部请求审批`}>
      <div className="pilot-gateway-approval-author">
        <span className="pilot-gateway-approval-avatar" aria-hidden="true">
          <SuperRoleAvatar
            name={approval.roleName}
            roleId={approval.roleId}
            avatarId={approval.avatarId}
            motion="still"
            size={24}
          />
        </span>
        <div className="pilot-gateway-approval-meta">
          <strong>{approval.roleName}</strong>
          <span className="pilot-gateway-approval-source">来自 {approval.requester}</span>
          <span className="pilot-gateway-approval-state" data-status={approval.status}>
            {approval.status === "pending" ? "待审批" : approval.status === "approved" ? "已同意" : "已拒绝"}
          </span>
        </div>
      </div>

      <p className="pilot-gateway-approval-ask">{approval.askText}</p>

      <div className="pilot-gateway-approval-card">
        <header className="pilot-gateway-approval-head">
          <h3>{approval.title}</h3>
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

        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}

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
                disabled={busy || !connected}
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
                <button type="submit" className="button danger" disabled={busy || !connected}>
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
                  disabled={busy || !connected}
                  onClick={() => setRejecting(true)}
                >
                  拒绝
                </button>
                <button
                  type="button"
                  className="button primary"
                  disabled={busy || !connected}
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
                ? "已同意，专员已开始创建并执行任务，进度将同步回外部请求方。"
                : `已拒绝该外部请求${approval.decisionReason ? `（原因：${approval.decisionReason}）` : ""}，已通知请求方。`}
            </small>
          </footer>
        )}
      </div>
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
  if (!approvals?.length) return null;
  return (
    <section className="pilot-gateway-approvals" aria-label="外部 MCP 任务审批">
      {approvals.map(approval => (
        <ApprovalCard
          key={approval.id}
          approval={approval}
          connected={connected}
          onDecided={onDecided}
        />
      ))}
    </section>
  );
}
