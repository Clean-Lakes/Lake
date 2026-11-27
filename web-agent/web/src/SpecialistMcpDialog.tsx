import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type {
  GatewayApprovalPolicy,
  GatewayInviteStatus,
  GatewayResourceGrant,
  SpecialistChannelInfo,
  SpecialistMcpState,
} from "../../shared/contracts";
import { api, readableError } from "./api";
import { AppSelect } from "./AppSelect";
import { Glyph, ResourceIcon } from "./Icons";
import { SuperRoleAvatar } from "./SuperRoleAvatar";
import { navigateSettingsTabs } from "./settingsFocus";
import "./specialistMcpDialog.css";

type TabId = "grants" | "invite";
type ExpiryPreset = "7d" | "30d" | "forever";

type DraftGrant = {
  selected: boolean;
  approvalPolicy: GatewayApprovalPolicy;
  expiry: ExpiryPreset;
  customExpiresAt?: string;
};

const DAY_MS = 86_400_000;

function presetFromExpiry(expiresAt?: string): ExpiryPreset {
  if (!expiresAt) return "forever";
  const diff = Date.parse(expiresAt) - Date.now();
  if (!Number.isFinite(diff) || diff <= 14 * DAY_MS) return "7d";
  return "30d";
}

function expiryIso(preset: ExpiryPreset): string | undefined {
  if (preset === "forever") return undefined;
  const days = preset === "30d" ? 30 : 7;
  return new Date(Date.now() + days * DAY_MS).toISOString();
}

function formatDateTime(value?: string) {
  if (!value) return "";
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(ms);
}

function inviteStatusLabel(status: GatewayInviteStatus) {
  return ({
    active: "待兑换",
    redeemed: "已接入",
    expired: "已过期",
    revoked: "已撤销",
  } as Record<GatewayInviteStatus, string>)[status];
}

function resourceKindLabel(kind: string) {
  return ({
    ssh: "SSH",
    local: "本机",
    docker: "Docker",
    kubernetes: "K8s",
    mysql: "MySQL",
    postgres: "PostgreSQL",
    redis: "Redis",
    sqlite: "SQLite",
    apisix: "APISIX",
    prometheus: "Prometheus",
    victoriametrics: "VM",
    grafana: "Grafana",
  } as Record<string, string>)[kind] ?? kind;
}

function buildDraft(state: SpecialistMcpState): Record<string, DraftGrant> {
  const existing = new Map((state.connection?.resourceGrants ?? []).map(grant => [grant.resourceId, grant]));
  const draft: Record<string, DraftGrant> = {};
  for (const resource of state.resources) {
    const saved = existing.get(resource.id);
    draft[resource.id] = saved
      ? {
          selected: true,
          approvalPolicy: saved.approvalPolicy,
          expiry: presetFromExpiry(saved.expiresAt),
          customExpiresAt: saved.expiresAt,
        }
      : {
          selected: false,
          approvalPolicy: "always_approve",
          expiry: "7d",
        };
  }
  return draft;
}

export function SpecialistMcpDialog({
  channel,
  projectName,
  anchor,
  onClose,
  onUpdated,
}: {
  channel: SpecialistChannelInfo;
  projectName: string;
  anchor?: HTMLElement | null;
  onClose: () => void;
  onUpdated?: () => void;
}) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [tab, setTab] = useState<TabId>("grants");
  const [state, setState] = useState<SpecialistMcpState | null>(null);
  const [draft, setDraft] = useState<Record<string, DraftGrant>>({});
  const [batchPolicy, setBatchPolicy] = useState<GatewayApprovalPolicy>("always_approve");
  const [batchExpiry, setBatchExpiry] = useState<ExpiryPreset>("7d");
  const [recipient, setRecipient] = useState("");
  const [ttlMinutes, setTtlMinutes] = useState("15");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [feedback, setFeedback] = useState("");
  const mounted = useRef(false);

  useLayoutEffect(() => {
    const node = dialogRef.current;
    if (!node) return;
    const previous = anchor ?? (document.activeElement as HTMLElement | null);
    node.showModal();
    return () => {
      node.close();
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, [anchor]);

  useEffect(() => {
    const controller = new AbortController();
    mounted.current = true;
    setLoading(true);
    setError("");
    void api.specialistMcp(channel.projectId, channel.roleId, controller.signal)
      .then(next => {
        if (controller.signal.aborted) return;
        setState(next);
        setDraft(buildDraft(next));
      })
      .catch(cause => {
        if (!controller.signal.aborted) setError(readableError(cause));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => {
      mounted.current = false;
      controller.abort();
    };
  }, [channel.projectId, channel.roleId]);

  const selectedIds = useMemo(
    () => (state?.resources ?? []).filter(resource => draft[resource.id]?.selected).map(resource => resource.id),
    [state?.resources, draft],
  );

  const confirmedGrants = useMemo(() => {
    const grants = state?.connection?.resourceGrants ?? [];
    const byId = new Map((state?.resources ?? []).map(resource => [resource.id, resource]));
    return grants.map(grant => ({
      ...grant,
      name: byId.get(grant.resourceId)?.name ?? grant.resourceId,
      expired: !!grant.expiresAt && Date.parse(grant.expiresAt) <= Date.now(),
    }));
  }, [state]);

  const requestClose = () => {
    if (!busy) onClose();
  };

  const updateRow = (resourceId: string, patch: Partial<DraftGrant>) => {
    setFeedback("");
    setDraft(current => ({
      ...current,
      [resourceId]: {
        ...(current[resourceId] ?? { selected: false, approvalPolicy: "always_approve", expiry: "7d" }),
        ...patch,
      },
    }));
  };

  const toggleAll = (selectAll: boolean) => {
    setFeedback("");
    setDraft(current => {
      const next: Record<string, DraftGrant> = {};
      for (const resource of state?.resources ?? []) {
        const existing = current[resource.id] ?? { selected: false, approvalPolicy: batchPolicy, expiry: batchExpiry };
        next[resource.id] = { ...existing, selected: selectAll };
      }
      return next;
    });
  };

  const applyBatchToSelected = () => {
    if (!selectedIds.length) return;
    setFeedback("已应用到已勾选资源，点击「确认授权」生效");
    setDraft(current => {
      const next = { ...current };
      for (const resourceId of selectedIds) {
        next[resourceId] = {
          ...(next[resourceId] ?? { selected: true, approvalPolicy: batchPolicy, expiry: batchExpiry }),
          selected: true,
          approvalPolicy: batchPolicy,
          expiry: batchExpiry,
          customExpiresAt: undefined,
        };
      }
      return next;
    });
  };

  async function saveGrants(switchToInvite = false) {
    if (!state || busy) return;
    setBusy("save");
    setError("");
    setFeedback("");
    try {
      const payload: GatewayResourceGrant[] = state.resources
        .filter(resource => draft[resource.id]?.selected)
        .map(resource => {
          const item = draft[resource.id]!;
          const expiresAt = item.customExpiresAt && presetFromExpiry(item.customExpiresAt) === item.expiry
            ? item.customExpiresAt
            : expiryIso(item.expiry);
          return {
            resourceId: resource.id,
            approvalPolicy: item.approvalPolicy,
            ...(expiresAt ? { expiresAt } : {}),
          };
        });
      const next = await api.saveSpecialistMcpGrants(channel.projectId, channel.roleId, {
        resourceGrants: payload,
        enabled: true,
        ...(state.connection?.updatedAt ? { expectedUpdatedAt: state.connection.updatedAt } : {}),
      });
      if (!mounted.current) return;
      setState(next);
      setDraft(buildDraft(next));
      setFeedback(payload.length ? `已确认 ${payload.length} 项资源授权` : "已清空授权资源范围");
      onUpdated?.();
      if (switchToInvite) setTab("invite");
    } catch (cause) {
      if (mounted.current) setError(readableError(cause));
    } finally {
      if (mounted.current) setBusy("");
    }
  }

  async function createInvite() {
    if (!state || busy) return;
    setBusy("invite");
    setError("");
    setFeedback("");
    try {
      const { invite, state: next } = await api.createSpecialistMcpInvite(channel.projectId, channel.roleId, {
        ...(recipient.trim() ? { recipient: recipient.trim() } : {}),
        ttlMinutes: Number(ttlMinutes) || 15,
      });
      if (!mounted.current) return;
      setState(next);
      setRecipient("");
      if (invite.invitePrompt) {
        try {
          await navigator.clipboard.writeText(invite.invitePrompt);
          setFeedback("已生成并复制接入邀请，直接发给 WorkBuddy 即可接入");
        } catch {
          setFeedback("已生成一次性接入邀请，点击下方按钮复制发送给 WorkBuddy");
        }
      } else {
        setFeedback("已生成一次性接入邀请");
      }
      onUpdated?.();
    } catch (cause) {
      if (mounted.current) setError(readableError(cause));
    } finally {
      if (mounted.current) setBusy("");
    }
  }

  async function revokeInvite(inviteId: string) {
    if (busy) return;
    setBusy("revoke:" + inviteId);
    setError("");
    setFeedback("");
    try {
      const next = await api.revokeSpecialistMcpInvite(channel.projectId, channel.roleId, inviteId);
      if (!mounted.current) return;
      setState(next);
      setFeedback("接入邀请已撤销");
      onUpdated?.();
    } catch (cause) {
      if (mounted.current) setError(readableError(cause));
    } finally {
      if (mounted.current) setBusy("");
    }
  }

  async function toggleConnectionEnabled(enable: boolean) {
    if (!state?.connection || busy) return;
    setBusy("toggle");
    setError("");
    setFeedback("");
    try {
      const next = enable
        ? await api.saveSpecialistMcpGrants(channel.projectId, channel.roleId, {
            resourceGrants: state.connection.resourceGrants ?? [],
            enabled: true,
            expectedUpdatedAt: state.connection.updatedAt,
          })
        : await api.disconnectSpecialistMcp(channel.projectId, channel.roleId);
      if (!mounted.current) return;
      setState(next);
      setFeedback(enable ? "MCP 接入连接已重新启用" : "MCP 接入连接已停用");
      onUpdated?.();
    } catch (cause) {
      if (mounted.current) setError(readableError(cause));
    } finally {
      if (mounted.current) setBusy("");
    }
  }

  async function copyText(textValue: string, message: string) {
    try {
      await navigator.clipboard.writeText(textValue);
      setError("");
      setFeedback(message);
    } catch {
      setError("无法写入剪贴板，请手动选中复制。");
    }
  }

  const grantsTabId = `${titleId}-tab-grants`;
  const inviteTabId = `${titleId}-tab-invite`;
  const grantsPanelId = `${titleId}-panel-grants`;
  const invitePanelId = `${titleId}-panel-invite`;

  return (
    <dialog
      ref={dialogRef}
      className="specialist-mcp-dialog"
      aria-labelledby={titleId}
      onCancel={event => {
        event.preventDefault();
        requestClose();
      }}
      onClick={event => {
        if (event.target !== event.currentTarget) return;
        const bounds = event.currentTarget.getBoundingClientRect();
        if (
          event.clientX < bounds.left ||
          event.clientX > bounds.right ||
          event.clientY < bounds.top ||
          event.clientY > bounds.bottom
        ) {
          requestClose();
        }
      }}
      onKeyDown={event => {
        if (event.key !== "Escape" || event.nativeEvent.isComposing || event.keyCode === 229) return;
        event.preventDefault();
        requestClose();
      }}
    >
      <header className="specialist-mcp-header">
        <div className="specialist-mcp-identity">
          <span className="specialist-mcp-avatar" aria-hidden="true">
            <SuperRoleAvatar
              name={channel.roleName}
              roleId={channel.roleId}
              avatarId={channel.avatarId}
              motion="still"
              size={22}
            />
          </span>
          <div className="specialist-mcp-heading">
            <h2 id={titleId}>MCP 接入</h2>
            <p title={`${channel.roleName} · ${projectName}`}>
              {channel.roleName} · {projectName}
            </p>
          </div>
        </div>
        <button
          type="button"
          className="icon-button"
          aria-label="关闭 MCP 接入"
          disabled={!!busy}
          onClick={requestClose}
        >
          <Glyph name="close" size={17} />
        </button>
      </header>

      <div className="specialist-mcp-tabs-bar">
        <div
          className="specialist-mcp-tabs"
          role="tablist"
          aria-label="MCP 接入页面"
          onKeyDown={event => navigateSettingsTabs(event, event.currentTarget)}
        >
          <button
            id={grantsTabId}
            type="button"
            role="tab"
            aria-selected={tab === "grants"}
            aria-controls={grantsPanelId}
            tabIndex={tab === "grants" ? 0 : -1}
            onClick={() => setTab("grants")}
          >
            <Glyph name="shieldOutline" size={14} />
            <span>资源授权</span>
            {confirmedGrants.length > 0 && <small>{confirmedGrants.length}</small>}
          </button>
          <button
            id={inviteTabId}
            type="button"
            role="tab"
            aria-selected={tab === "invite"}
            aria-controls={invitePanelId}
            tabIndex={tab === "invite" ? 0 : -1}
            onClick={() => setTab("invite")}
          >
            <Glyph name="link" size={14} />
            <span>接入邀请</span>
          </button>
        </div>
        <span className="specialist-mcp-conn-badge" data-state={state?.connection?.enabled ? "active" : "idle"}>
          <i aria-hidden="true" />
          {state?.connection
            ? state.connection.enabled
              ? "已启用"
              : "已停用"
            : "尚未配置"}
        </span>
      </div>

      {error && (
        <p className="specialist-mcp-alert" role="alert">
          {error}
        </p>
      )}
      {feedback && !error && (
        <p className="specialist-mcp-status" role="status">
          {feedback}
        </p>
      )}

      {loading ? (
        <div className="specialist-mcp-loading" role="status">
          <Glyph name="loader" size={16} />
          <span>正在读取专员 MCP 接入配置…</span>
        </div>
      ) : tab === "grants" ? (
        <section
          id={grantsPanelId}
          role="tabpanel"
          aria-labelledby={grantsTabId}
          className="specialist-mcp-body"
        >
          <div className="specialist-mcp-batch-bar">
            <div className="specialist-mcp-batch-selection">
              <span>已勾选 {selectedIds.length} / {state?.resources.length ?? 0}</span>
              {(state?.resources.length ?? 0) > 0 && (
                <button
                  type="button"
                  className="specialist-mcp-link-btn"
                  disabled={!!busy}
                  onClick={() => toggleAll(selectedIds.length < (state?.resources.length ?? 0))}
                >
                  {selectedIds.length < (state?.resources.length ?? 0) ? "全选" : "取消全选"}
                </button>
              )}
            </div>
            <div className="specialist-mcp-batch-controls">
              <AppSelect
                label="批量审批方式"
                value={batchPolicy}
                disabled={!!busy}
                onChange={event => setBatchPolicy(event.target.value as GatewayApprovalPolicy)}
              >
                <option value="always_approve">每次人工审批</option>
                <option value="auto_in_scope">授权范围内免审批</option>
              </AppSelect>
              <AppSelect
                label="批量有效期"
                value={batchExpiry}
                disabled={!!busy}
                onChange={event => setBatchExpiry(event.target.value as ExpiryPreset)}
              >
                <option value="7d">7 天</option>
                <option value="30d">30 天</option>
                <option value="forever">长期有效</option>
              </AppSelect>
              <button
                type="button"
                className="button secondary specialist-mcp-compact-btn"
                disabled={!!busy || !selectedIds.length}
                onClick={applyBatchToSelected}
              >
                批量应用
              </button>
            </div>
          </div>

          {state?.resources.length ? (
            <div className="specialist-mcp-resource-list" role="group" aria-label="项目资源授权清单">
              {state.resources.map(resource => {
                const item = draft[resource.id] ?? { selected: false, approvalPolicy: "always_approve", expiry: "7d" };
                return (
                  <div
                    key={resource.id}
                    className={`specialist-mcp-resource-row${item.selected ? " is-selected" : ""}`}
                  >
                    <label className="specialist-mcp-resource-check">
                      <input
                        type="checkbox"
                        checked={item.selected}
                        disabled={!!busy}
                        onChange={event => updateRow(resource.id, { selected: event.target.checked })}
                      />
                      <span className="specialist-mcp-resource-icon">
                        <ResourceIcon kind={resource.kind} size={15} />
                      </span>
                      <span className="specialist-mcp-resource-meta">
                        <strong title={resource.name}>{resource.name}</strong>
                        <small>
                          <span className="specialist-mcp-kind-badge">{resourceKindLabel(resource.kind)}</span>
                          {resource.host && <span>{resource.host}</span>}
                        </small>
                      </span>
                    </label>
                    <div className="specialist-mcp-resource-controls">
                      <AppSelect
                        label={`${resource.name} 审批方式`}
                        value={item.approvalPolicy}
                        disabled={!!busy || !item.selected}
                        onChange={event =>
                          updateRow(resource.id, { approvalPolicy: event.target.value as GatewayApprovalPolicy })
                        }
                      >
                        <option value="always_approve">每次审批</option>
                        <option value="auto_in_scope">范围内免审批</option>
                      </AppSelect>
                      <AppSelect
                        label={`${resource.name} 有效期`}
                        value={item.expiry}
                        disabled={!!busy || !item.selected}
                        onChange={event =>
                          updateRow(resource.id, {
                            expiry: event.target.value as ExpiryPreset,
                            customExpiresAt: undefined,
                          })
                        }
                      >
                        <option value="7d">7 天</option>
                        <option value="30d">30 天</option>
                        <option value="forever">长期</option>
                      </AppSelect>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="specialist-mcp-empty">当前项目暂无可授权资源。请先在项目资源中添加主机、数据库或服务。</p>
          )}

          <p className="specialist-mcp-note">
            勾选仅确定候选范围，点击「确认授权」后生效。默认每次外部执行均在 Lake 主对话发起人工审批；启用免审批时后端仍逐次核对连接、专员、资源和有效期，越权或过期直接拦截。
          </p>
        </section>
      ) : (
        <section
          id={invitePanelId}
          role="tabpanel"
          aria-labelledby={inviteTabId}
          className="specialist-mcp-body"
        >
          <div className="specialist-mcp-scope-card">
            <div className="specialist-mcp-scope-top">
              <strong>当前已生效授权范围</strong>
              <button
                type="button"
                className="specialist-mcp-link-btn"
                onClick={() => setTab("grants")}
              >
                调整资源授权
              </button>
            </div>
            {confirmedGrants.length ? (
              <div className="specialist-mcp-scope-tags">
                {confirmedGrants.map(grant => (
                  <span
                    key={grant.resourceId}
                    className={`specialist-mcp-scope-tag${grant.expired ? " is-expired" : ""}`}
                  >
                    {grant.name}
                    <small>
                      {grant.expired
                        ? "已过期"
                        : grant.approvalPolicy === "auto_in_scope"
                          ? "免审批"
                          : "每次审批"}
                    </small>
                  </span>
                ))}
              </div>
            ) : (
              <p className="specialist-mcp-note">尚未确认授权资源，请先在「资源授权」勾选并确认。</p>
            )}
            {state?.remoteEndpoint && (
              <div className="specialist-mcp-endpoint-row">
                <span>Streamable HTTP 地址</span>
                <code title={state.remoteEndpoint}>{state.remoteEndpoint}</code>
                <button
                  type="button"
                  className="icon-button"
                  aria-label="复制远程 MCP 地址"
                  title="复制地址"
                  onClick={() => void copyText(state.remoteEndpoint, "远程 MCP 地址已复制")}
                >
                  <Glyph name="copy" size={14} />
                </button>
              </div>
            )}
          </div>

          <form
            className="specialist-mcp-invite-form"
            onSubmit={event => {
              event.preventDefault();
              void createInvite();
            }}
          >
            <label className="specialist-mcp-field">
              <span>接收者（可选）</span>
              <input
                type="text"
                value={recipient}
                maxLength={80}
                placeholder="例如：林明（研发）"
                disabled={!!busy || !state?.connection?.enabled}
                onChange={event => setRecipient(event.target.value)}
              />
            </label>
            <label className="specialist-mcp-field specialist-mcp-ttl-field">
              <span>链接有效期</span>
              <AppSelect
                label="邀请链接有效期"
                value={ttlMinutes}
                disabled={!!busy || !state?.connection?.enabled}
                onChange={event => setTtlMinutes(event.target.value)}
              >
                <option value="15">15 分钟</option>
                <option value="60">1 小时</option>
                <option value="1440">24 小时</option>
              </AppSelect>
            </label>
            <button
              type="submit"
              className="button primary specialist-mcp-generate-btn"
              disabled={!!busy || !state?.connection?.enabled}
            >
              <Glyph name="link" size={14} />
              <span>{busy === "invite" ? "生成中…" : "生成接入链接"}</span>
            </button>
          </form>

          {state?.invites.length ? (
            <div className="specialist-mcp-invite-list">
              {state.invites.map(invite => (
                <div key={invite.id} className="specialist-mcp-invite-row">
                  <div className="specialist-mcp-invite-meta">
                    <strong>
                      {invite.recipient ? `发给 ${invite.recipient}` : "WorkBuddy 接入邀请"}
                      <span className="specialist-mcp-invite-status" data-status={invite.status}>
                        {inviteStatusLabel(invite.status)}
                      </span>
                    </strong>
                    <small>
                      创建于 {formatDateTime(invite.createdAt)} ·{" "}
                      {invite.redeemedAt
                        ? `兑换于 ${formatDateTime(invite.redeemedAt)}`
                        : invite.revokedAt
                          ? `撤销于 ${formatDateTime(invite.revokedAt)}`
                          : `有效期至 ${formatDateTime(invite.expiresAt)}`}
                    </small>
                  </div>
                  {invite.status === "active" && invite.invitePrompt && (
                    <>
                      <pre className="specialist-mcp-invite-prompt">{invite.invitePrompt}</pre>
                      <div className="specialist-mcp-invite-actions">
                        <button
                          type="button"
                          className="button secondary specialist-mcp-compact-btn"
                          disabled={!!busy}
                          onClick={() => void revokeInvite(invite.id)}
                        >
                          撤销
                        </button>
                        <button
                          type="button"
                          className="button primary specialist-mcp-compact-btn"
                          disabled={!!busy}
                          onClick={() =>
                            void copyText(invite.invitePrompt!, "已复制接入邀请，发给 WorkBuddy 即可自动配置 MCP")
                          }
                        >
                          <Glyph name="copy" size={13} />
                          <span>复制接入邀请</span>
                        </button>
                      </div>
                    </>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <p className="specialist-mcp-empty">
              生成一次性邀请链接后，点击「复制接入邀请」发给 WorkBuddy，对方确认信任后即自动完成连接配置。
            </p>
          )}

          {state?.connection && (
            <div className="specialist-mcp-connection-footer">
              <span>
                连接名称：{state.connection.name}
                {state.connection.lastReceivedAt ? ` · 最近调用 ${formatDateTime(state.connection.lastReceivedAt)}` : ""}
              </span>
              <button
                type="button"
                className={`specialist-mcp-link-btn${state.connection.enabled ? " is-danger" : ""}`}
                disabled={!!busy}
                onClick={() => void toggleConnectionEnabled(!state.connection!.enabled)}
              >
                {state.connection.enabled ? "停用接入" : "重新启用"}
              </button>
            </div>
          )}
        </section>
      )}

      <footer className="specialist-mcp-footer">
        <span className="specialist-mcp-footer-hint">
          {tab === "grants" ? "单条和批量授权均须确认后生效" : "邀请链接单次有效，可随时撤销"}
        </span>
        <div className="specialist-mcp-footer-actions">
          <button type="button" className="button secondary" disabled={!!busy} onClick={requestClose}>
            关闭
          </button>
          {tab === "grants" && (
            <button
              type="button"
              className="button primary"
              disabled={!!busy || loading}
              onClick={() => void saveGrants(true)}
            >
              {busy === "save" ? "保存中…" : "确认授权"}
            </button>
          )}
        </div>
      </footer>
    </dialog>
  );
}
