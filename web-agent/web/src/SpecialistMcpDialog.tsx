import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type {
  GatewayInviteStatus,
  GatewayInviteView,
  GatewayResourceGrant,
  SpecialistChannelInfo,
  SpecialistMcpState,
} from "../../shared/contracts";
import { api, ApiRequestError, readableError } from "./api";
import { AppSelect } from "./AppSelect";
import { Glyph, ResourceIcon } from "./Icons";
import { SuperRoleAvatar } from "./SuperRoleAvatar";
import { navigateSettingsTabs } from "./settingsFocus";
import "./specialistMcpDialog.css";

type TabId = "grants" | "invite";
type ExpiryPreset = "7d" | "30d" | "forever";

type DraftGrant = {
  selected: boolean;
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
          expiry: presetFromExpiry(saved.expiresAt),
          customExpiresAt: saved.expiresAt,
        }
      : {
          selected: false,
          expiry: "7d",
        };
  }
  return draft;
}

export function selectSpecialistInviteSlot(invites?: readonly GatewayInviteView[]) {
  const list = invites ?? [];
  const current = list.find(invite => invite.status === "active" || invite.status === "redeemed") ?? null;
  const lastInactive = current ? null : (list[0] ?? null);
  return { current, lastInactive, canCreate: current === null };
}

export function SpecialistMcpInviteSlot({
  roleName,
  invites,
  connectionEnabled,
  busy,
  inviteName,
  ttlMinutes,
  onInviteNameChange,
  onTtlMinutesChange,
  onCreateInvite,
  onRevokeInvite,
  onCopyPrompt,
}: {
  roleName: string;
  invites?: readonly GatewayInviteView[];
  connectionEnabled: boolean;
  busy: string;
  inviteName: string;
  ttlMinutes: string;
  onInviteNameChange: (value: string) => void;
  onTtlMinutesChange: (value: string) => void;
  onCreateInvite: () => void;
  onRevokeInvite: (inviteId: string, wasRedeemed: boolean) => void;
  onCopyPrompt: (prompt: string) => void;
}) {
  const { current: currentInvite, lastInactive: lastInactiveInvite } = selectSpecialistInviteSlot(invites);

  if (currentInvite) {
    return (
      <div className="specialist-mcp-invite-list">
        <div className="specialist-mcp-invite-row">
          <div className="specialist-mcp-invite-meta">
            <strong>
              {currentInvite.name || currentInvite.recipient || `${roleName} MCP 接入邀请`}
              <span className="specialist-mcp-invite-status" data-status={currentInvite.status}>
                {inviteStatusLabel(currentInvite.status)}
              </span>
            </strong>
            <small>
              创建于 {formatDateTime(currentInvite.createdAt)} ·{" "}
              {currentInvite.redeemedAt
                ? `兑换于 ${formatDateTime(currentInvite.redeemedAt)}`
                : `有效期至 ${formatDateTime(currentInvite.expiresAt)}`}
            </small>
          </div>
          {currentInvite.status === "active" && currentInvite.invitePrompt ? (
            <>
              <pre className="specialist-mcp-invite-prompt">{currentInvite.invitePrompt}</pre>
              <div className="specialist-mcp-invite-actions is-split">
                <span className="specialist-mcp-invite-hint">
                  每个专员仅支持一个邀请链接，如需更换请先撤销
                </span>
                <div className="specialist-mcp-invite-buttons">
                  <button
                    type="button"
                    className="button secondary specialist-mcp-compact-btn"
                    disabled={!!busy}
                    onClick={() => onRevokeInvite(currentInvite.id, false)}
                  >
                    撤销
                  </button>
                  <button
                    type="button"
                    className="button primary specialist-mcp-compact-btn"
                    disabled={!!busy || !connectionEnabled}
                    onClick={() => onCopyPrompt(currentInvite.invitePrompt!)}
                  >
                    <Glyph name="copy" size={13} />
                    <span>复制接入邀请</span>
                  </button>
                </div>
              </div>
            </>
          ) : (
            <div className="specialist-mcp-invite-actions is-split">
              <span className="specialist-mcp-invite-hint">
                每个专员仅支持一个邀请链接；撤销当前接入后原客户端凭据会立即失效，届时可重新生成。
              </span>
              <div className="specialist-mcp-invite-buttons">
                <button
                  type="button"
                  className="button secondary specialist-mcp-compact-btn"
                  disabled={!!busy}
                  onClick={() => onRevokeInvite(currentInvite.id, true)}
                >
                  撤销并重置
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <>
      <form
        className="specialist-mcp-invite-form"
        onSubmit={event => {
          event.preventDefault();
          onCreateInvite();
        }}
      >
        <label className="specialist-mcp-field">
          <span>邀请名称</span>
          <input
            type="text"
            value={inviteName}
            maxLength={80}
            placeholder={`例如：${roleName} · 研发预发接入`}
            disabled={!!busy || !connectionEnabled}
            onChange={event => onInviteNameChange(event.target.value)}
          />
        </label>
        <label className="specialist-mcp-field specialist-mcp-ttl-field">
          <span>链接有效期</span>
          <AppSelect
            label="邀请链接有效期"
            value={ttlMinutes}
            disabled={!!busy || !connectionEnabled}
            onChange={event => onTtlMinutesChange(event.target.value)}
          >
            <option value="15">15 分钟</option>
            <option value="60">1 小时</option>
            <option value="1440">24 小时</option>
          </AppSelect>
        </label>
        <button
          type="submit"
          className="button primary specialist-mcp-generate-btn"
          disabled={!!busy || !connectionEnabled}
        >
          <Glyph name="link" size={14} />
          <span>{busy === "invite" ? "生成中…" : "生成接入链接"}</span>
        </button>
      </form>

      <p className="specialist-mcp-empty">
        {lastInactiveInvite?.status === "expired"
          ? "上次生成的邀请链接已过期。每个专员仅支持一个邀请链接，可在此重新生成后发给外部 MCP 客户端。"
          : "每个专员仅支持一个邀请链接。生成后点击「复制接入邀请」发给任意支持 Streamable HTTP 的外部 Agent 或 MCP 客户端，确认信任后即可完成接入。"}
      </p>
    </>
  );
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
  const [batchExpiry, setBatchExpiry] = useState<ExpiryPreset>("7d");
  const [resourceQuery, setResourceQuery] = useState("");
  const [onlySelected, setOnlySelected] = useState(false);
  const [scopeExpanded, setScopeExpanded] = useState(false);
  const [inviteName, setInviteName] = useState("");
  const [ttlMinutes, setTtlMinutes] = useState("15");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [feedback, setFeedback] = useState("");
  const mounted = useRef(false);
  const inviteSubmitting = useRef(false);

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

  const visibleResources = useMemo(() => {
    const query = resourceQuery.trim().toLowerCase();
    return (state?.resources ?? []).filter(resource => {
      if (onlySelected && !draft[resource.id]?.selected) return false;
      if (!query) return true;
      return (
        resource.name.toLowerCase().includes(query) ||
        resource.kind.toLowerCase().includes(query) ||
        resourceKindLabel(resource.kind).toLowerCase().includes(query) ||
        (resource.host?.toLowerCase().includes(query) ?? false)
      );
    });
  }, [state?.resources, resourceQuery, onlySelected, draft]);

  const visibleSelectedCount = useMemo(
    () => visibleResources.filter(resource => draft[resource.id]?.selected).length,
    [visibleResources, draft],
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

  const { current: currentInvite } = useMemo(
    () => selectSpecialistInviteSlot(state?.invites),
    [state?.invites],
  );

  const requestClose = () => {
    if (!busy) onClose();
  };

  const updateRow = (resourceId: string, patch: Partial<DraftGrant>) => {
    setFeedback("");
    setDraft(current => ({
      ...current,
      [resourceId]: {
        ...(current[resourceId] ?? { selected: false, expiry: "7d" }),
        ...patch,
      },
    }));
  };

  const toggleVisible = (selectAll: boolean) => {
    setFeedback("");
    setDraft(current => {
      const next: Record<string, DraftGrant> = { ...current };
      for (const resource of visibleResources) {
        const existing = next[resource.id] ?? { selected: false, expiry: batchExpiry };
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
          ...(next[resourceId] ?? { selected: true, expiry: batchExpiry }),
          selected: true,
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
    if (!state || busy || currentInvite || inviteSubmitting.current) return;
    inviteSubmitting.current = true;
    setBusy("invite");
    setError("");
    setFeedback("");
    try {
      const { invite, state: next } = await api.createSpecialistMcpInvite(channel.projectId, channel.roleId, {
        ...(inviteName.trim() ? { name: inviteName.trim() } : {}),
        ttlMinutes: Number(ttlMinutes) || 15,
      });
      if (!mounted.current) return;
      setState(next);
      setInviteName("");
      if (invite.invitePrompt) {
        try {
          await navigator.clipboard.writeText(invite.invitePrompt);
          setFeedback("已生成并复制接入邀请，发给外部 Agent 或 MCP 客户端即可接入");
        } catch {
          setFeedback("已生成一次性接入邀请，点击下方按钮复制发送给外部 MCP 客户端");
        }
      } else {
        setFeedback("已生成一次性接入邀请");
      }
      onUpdated?.();
    } catch (cause) {
      if (mounted.current) {
        setError(readableError(cause));
        if (cause instanceof ApiRequestError && cause.status === 409) {
          void api.specialistMcp(channel.projectId, channel.roleId)
            .then(latest => {
              if (mounted.current) setState(latest);
            })
            .catch(() => {});
        }
      }
    } finally {
      inviteSubmitting.current = false;
      if (mounted.current) setBusy("");
    }
  }

  async function revokeInvite(inviteId: string, wasRedeemed: boolean) {
    if (busy) return;
    setBusy("revoke:" + inviteId);
    setError("");
    setFeedback("");
    try {
      const next = await api.revokeSpecialistMcpInvite(channel.projectId, channel.roleId, inviteId);
      if (!mounted.current) return;
      setState(next);
      setFeedback(
        wasRedeemed
          ? "已撤销当前接入并重置凭据，现在可重新生成新的邀请链接"
          : "接入邀请已撤销，现在可重新生成新的邀请链接",
      );
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
      role="dialog"
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
          <div className="specialist-mcp-toolbar">
            <div className="specialist-mcp-search-row">
              <label className="specialist-mcp-search">
                <Glyph name="search" size={14} />
                <input
                  type="search"
                  value={resourceQuery}
                  placeholder="搜索资源名称、类型或主机…"
                  aria-label="搜索项目资源"
                  onChange={event => setResourceQuery(event.target.value)}
                />
              </label>
              <label className="specialist-mcp-filter-toggle">
                <input
                  type="checkbox"
                  checked={onlySelected}
                  onChange={event => setOnlySelected(event.target.checked)}
                />
                <span>仅看已勾选</span>
              </label>
            </div>
            <div className="specialist-mcp-batch-bar">
              <div className="specialist-mcp-batch-selection">
                <span>已勾选 {selectedIds.length} / {state?.resources.length ?? 0}</span>
                {visibleResources.length > 0 && (
                  <button
                    type="button"
                    className="specialist-mcp-link-btn"
                    disabled={!!busy}
                    onClick={() => toggleVisible(visibleSelectedCount < visibleResources.length)}
                  >
                    {visibleSelectedCount < visibleResources.length
                      ? (resourceQuery.trim() || onlySelected ? "全选当前" : "全选")
                      : (resourceQuery.trim() || onlySelected ? "取消当前" : "取消全选")}
                  </button>
                )}
              </div>
              <div className="specialist-mcp-batch-controls">
                <AppSelect
                  className="specialist-mcp-select-expiry"
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
          </div>

          {visibleResources.length ? (
            <div className="specialist-mcp-resource-list" role="group" aria-label="项目资源授权清单">
              {visibleResources.map(resource => {
                const item = draft[resource.id] ?? { selected: false, expiry: "7d" };
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
                        className="specialist-mcp-row-expiry"
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
            <p className="specialist-mcp-empty">
              {state?.resources.length
                ? "没有匹配的资源，请调整搜索关键词或取消「仅看已勾选」。"
                : "当前项目暂无可授权资源。请先在项目资源中添加主机、数据库或服务。"}
            </p>
          )}

          <p className="specialist-mcp-note">
            勾选仅确定候选范围，点击「确认授权」后生效。收到外部 MCP 消息时，专员会在已授权且未过期的资源范围内直接处理，并主动在 Lake 主对话发通知；涉及未授权或已过期资源的请求会被后端直接拦截。
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
              <strong>当前已生效授权范围（{confirmedGrants.length} 项）</strong>
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
                {(scopeExpanded ? confirmedGrants : confirmedGrants.slice(0, 6)).map(grant => (
                  <span
                    key={grant.resourceId}
                    className={`specialist-mcp-scope-tag${grant.expired ? " is-expired" : ""}`}
                  >
                    {grant.name}
                    {grant.expired && <small>已过期</small>}
                  </span>
                ))}
                {confirmedGrants.length > 6 && (
                  <button
                    type="button"
                    className="specialist-mcp-scope-more"
                    onClick={() => setScopeExpanded(current => !current)}
                  >
                    {scopeExpanded ? "收起" : `其余 ${confirmedGrants.length - 6} 项`}
                  </button>
                )}
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

          <SpecialistMcpInviteSlot
            roleName={channel.roleName}
            invites={state?.invites}
            connectionEnabled={!!state?.connection?.enabled}
            busy={busy}
            inviteName={inviteName}
            ttlMinutes={ttlMinutes}
            onInviteNameChange={setInviteName}
            onTtlMinutesChange={setTtlMinutes}
            onCreateInvite={() => void createInvite()}
            onRevokeInvite={(inviteId, wasRedeemed) => void revokeInvite(inviteId, wasRedeemed)}
            onCopyPrompt={prompt =>
              void copyText(prompt, "已复制接入邀请，发给外部 MCP 客户端即可配置连接")
            }
          />

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
          {tab === "grants" ? "单条和批量授权均须确认后生效" : "每个专员仅保留一个邀请链接，可随时撤销"}
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
