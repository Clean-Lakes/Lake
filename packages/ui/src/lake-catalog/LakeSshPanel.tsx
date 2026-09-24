import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { createUuid } from "@zcode/shared";
import type { ITerminalService, LakeResource, LakeSshProfile } from "@zcode/services";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { TerminalSession } from "@/terminal/TerminalSession.js";
import { lakeCatalogCopy } from "./lakeCatalogCopy.js";

type SessionStatus = "opening" | "running" | "exited" | "failed";
type SshTab = { id: string; status: SessionStatus; index: number };

const fieldClass = "flex flex-col gap-1.5 text-ui-sm text-foreground-subtle";

function LakeSshSessionView({
  resourceId,
  tab,
  visible,
  onStatus,
}: {
  resourceId: string;
  tab: SshTab;
  visible: boolean;
  onStatus: (id: string, status: SessionStatus) => void;
}) {
  const services = useBaseWorkspaceServices();
  const platform = usePlatform();
  const createTerminal = useCallback<ITerminalService["create"]>(
    async ({ cols, rows }) => {
      try {
        const created = await services.terminalService.createLakeSsh({ resourceId, cols, rows });
        onStatus(tab.id, "running");
        return created;
      } catch (error) {
        onStatus(tab.id, "failed");
        throw error;
      }
    },
    [onStatus, resourceId, services.terminalService, tab.id],
  );
  const handleExit = useCallback(() => onStatus(tab.id, "exited"), [onStatus, tab.id]);
  const ignoreShellLabel = useCallback(() => {}, []);

  return (
    <div className={visible ? "h-full min-h-0" : "hidden"}>
      <TerminalSession
        sessionId={tab.id}
        services={services}
        createTerminal={createTerminal}
        isVisible={visible}
        onShellLabelChange={ignoreShellLabel}
        onExit={handleExit}
        onOpenBrowserUrl={(url) => platform.openExternal(url)}
      />
    </div>
  );
}

export function LakeSshPanel({ resource }: { resource: LakeResource }) {
  const { locale } = useZCodeIntl();
  const t = lakeCatalogCopy[locale];
  const catalog = useBaseWorkspaceServices().lakeCatalogService;
  const [profile, setProfile] = useState<LakeSshProfile | null>(null);
  const [host, setHost] = useState("");
  const [port, setPort] = useState("22");
  const [username, setUsername] = useState("");
  const [privateKeyPath, setPrivateKeyPath] = useState("");
  const [hasSavedPassword, setHasSavedPassword] = useState(false);
  const [passwordDraft, setPasswordDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [passwordSaving, setPasswordSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tabs, setTabs] = useState<SshTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  // 关闭旧标签后不能复用显示序号，否则重连会出现两个同名终端。
  const nextTabIndex = useRef(1);

  useEffect(() => {
    let active = true;
    void Promise.all([
      catalog.getSshProfile(resource.id),
      catalog.hasSshPassword(resource.id),
    ]).then(
      ([nextProfile, savedPassword]) => {
        if (!active) return;
        setProfile(nextProfile);
        setHasSavedPassword(savedPassword);
        setHost(nextProfile?.host ?? "");
        setPort(String(nextProfile?.port ?? 22));
        setUsername(nextProfile?.username ?? "");
        setPrivateKeyPath(nextProfile?.privateKeyPath ?? "");
        setLoading(false);
      },
      (cause: unknown) => {
        if (!active) return;
        setError(String(cause));
        setLoading(false);
      },
    );
    return () => {
      active = false;
    };
  }, [catalog, resource.id]);

  const dirty = useMemo(
    () =>
      host.trim() !== (profile?.host ?? "") ||
      port.trim() !== String(profile?.port ?? 22) ||
      username.trim() !== (profile?.username ?? "") ||
      privateKeyPath.trim() !== (profile?.privateKeyPath ?? ""),
    [host, port, username, privateKeyPath, profile],
  );

  const saveProfile = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    void catalog
      .saveSshProfile(resource.id, {
        host,
        port: Number(port),
        username,
        ...(privateKeyPath.trim() ? { privateKeyPath } : {}),
      })
      .then(setProfile)
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setSaving(false));
  };

  const savePassword = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!profile || !passwordDraft) return;
    setPasswordSaving(true);
    setError(null);
    void catalog
      .saveSshPassword(resource.id, passwordDraft)
      .then(() => {
        setHasSavedPassword(true);
        setPasswordDraft("");
      })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setPasswordSaving(false));
  };

  const deletePassword = () => {
    setPasswordSaving(true);
    setError(null);
    void catalog
      .deleteSshPassword(resource.id)
      .then(() => setHasSavedPassword(false))
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setPasswordSaving(false));
  };

  const setSessionStatus = useCallback((id: string, status: SessionStatus) => {
    setTabs((current) =>
      current.map((tab) => (tab.id === id && tab.status !== status ? { ...tab, status } : tab)),
    );
  }, []);

  const connect = () => {
    if (!profile || dirty) return;
    const tab: SshTab = { id: createUuid(), status: "opening", index: nextTabIndex.current++ };
    setTabs((current) => [...current, tab]);
    setActiveTabId(tab.id);
  };

  const closeTab = (id: string) => {
    setTabs((current) => current.filter((tab) => tab.id !== id));
    setActiveTabId((current) =>
      current === id ? (tabs.find((tab) => tab.id !== id)?.id ?? null) : current,
    );
  };

  return (
    <section
      className="space-y-4 rounded-lg border border-border bg-surface p-4"
      data-testid="lake-ssh-panel"
    >
      <div>
        <h3 className="text-ui-base font-semibold text-foreground">
          {resource.name} · {t.sshTitle}
        </h3>
        <p className="mt-1 text-ui-sm text-foreground-subtle">{t.sshIntro}</p>
      </div>
      {error ? (
        <p role="alert" className="text-ui-sm text-destructive">
          {error}
        </p>
      ) : null}
      {loading ? <p className="text-ui-sm text-foreground-subtle">{t.loading}</p> : null}
      <form onSubmit={saveProfile} className="grid gap-3 sm:grid-cols-2">
        <label className={fieldClass}>
          {t.sshHost}
          <Input
            value={host}
            onChange={(event) => setHost(event.target.value)}
            required
            maxLength={255}
          />
        </label>
        <label className={fieldClass}>
          {t.sshPort}
          <Input
            value={port}
            onChange={(event) => setPort(event.target.value)}
            required
            type="number"
            min={1}
            max={65535}
          />
        </label>
        <label className={fieldClass}>
          {t.sshUsername}
          <Input
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            required
            maxLength={64}
          />
        </label>
        <label className={fieldClass}>
          {t.sshPrivateKeyPath}
          <Input
            value={privateKeyPath}
            onChange={(event) => setPrivateKeyPath(event.target.value)}
            maxLength={1024}
            placeholder={t.sshOptionalKey}
          />
        </label>
        <div className="flex flex-wrap items-center gap-2 sm:col-span-2">
          <Button type="submit" disabled={loading || saving || !dirty}>
            {saving ? t.saving : t.sshSave}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={!profile || dirty || loading || passwordSaving || Boolean(passwordDraft)}
            onClick={connect}
          >
            {t.sshConnect}
          </Button>
          {dirty && profile ? (
            <span className="text-ui-sm text-foreground-subtle">{t.sshSaveBeforeConnect}</span>
          ) : null}
        </div>
      </form>
      <form onSubmit={savePassword} className="space-y-3 border-t border-border pt-4">
        <div>
          <h4 className="text-ui-base font-medium text-foreground">{t.sshPassword}</h4>
          <p className="mt-1 text-ui-sm text-foreground-subtle">{t.sshPasswordHint}</p>
        </div>
        <label className={fieldClass}>
          {t.sshPassword}
          <Input
            type="password"
            autoComplete="new-password"
            value={passwordDraft}
            onChange={(event) => setPasswordDraft(event.target.value)}
            maxLength={4096}
            placeholder={hasSavedPassword ? t.sshPasswordSavedPlaceholder : undefined}
            disabled={loading || passwordSaving}
          />
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" disabled={!profile || !passwordDraft || passwordSaving}>
            {passwordSaving ? t.saving : t.sshSavePassword}
          </Button>
          {hasSavedPassword ? (
            <Button
              type="button"
              variant="outline"
              disabled={passwordSaving}
              onClick={deletePassword}
            >
              {t.sshDeletePassword}
            </Button>
          ) : null}
          <span className="text-ui-sm text-foreground-subtle">
            {hasSavedPassword ? t.sshPasswordSaved : t.sshPasswordMissing}
          </span>
        </div>
        {!profile ? (
          <p className="text-ui-sm text-foreground-subtle">{t.sshSaveBeforePassword}</p>
        ) : null}
      </form>
      {tabs.length > 0 ? (
        <div className="space-y-2">
          <div className="flex flex-wrap gap-2" role="tablist" aria-label={t.sshSessions}>
            {tabs.map((tab) => (
              <div key={tab.id} className="flex items-center rounded-md border border-border">
                <button
                  type="button"
                  role="tab"
                  aria-selected={activeTabId === tab.id}
                  onClick={() => setActiveTabId(tab.id)}
                  className="px-2 py-1 text-ui-sm text-foreground"
                >
                  {t.sshSession} {tab.index} · {t[tab.status]}
                </button>
                <button
                  type="button"
                  aria-label={`${t.sshDisconnect} ${tab.index}`}
                  onClick={() => closeTab(tab.id)}
                  className="px-2 py-1 text-ui-sm text-foreground-subtle hover:text-foreground"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
          <div
            className="h-80 overflow-hidden rounded-md border border-border bg-background"
            role="tabpanel"
          >
            {tabs.map((tab) => (
              <LakeSshSessionView
                key={tab.id}
                resourceId={resource.id}
                tab={tab}
                visible={tab.id === activeTabId}
                onStatus={setSessionStatus}
              />
            ))}
          </div>
          <p className="text-ui-xs text-foreground-subtlest">{t.sshSessionHint}</p>
        </div>
      ) : null}
    </section>
  );
}
