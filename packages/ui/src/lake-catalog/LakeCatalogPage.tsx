/* eslint-disable max-lines -- 目录页的创建、绑定、资源与 SSH 状态属于同一当前湖视图；后续独立拆页时再分离。 */
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { ArrowLeft, FolderOpen, Link2 } from "lucide-react";
import {
  type Lake,
  type LakeResource,
  type LakeResourceEnvironment,
  type LakeResourceKind,
} from "@zcode/services";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { Textarea } from "@/components/ui/textarea.js";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { notifyLakeCatalogChanged } from "@/lib/lakeCatalogChanged.js";
import { lakeCatalogCopy } from "./lakeCatalogCopy.js";
import {
  ActionPanel,
  CatalogEmptyState,
  CatalogLoadingState,
  LakeNavigation,
  LakeOverview,
  ResourceListLoadingState,
} from "./LakeCatalogPageParts.js";
import { LakeResourceList } from "./LakeResourceList.js";
import { LakeSshPanel } from "./LakeSshPanel.js";

const resourceKinds: LakeResourceKind[] = ["service", "host", "kubernetes-cluster", "database"];
const environments: LakeResourceEnvironment[] = ["production", "staging", "development", "other"];
const fieldClass = "flex flex-col gap-1.5 text-ui-sm font-medium text-foreground-subtle";
const selectClass =
  "h-9 w-full rounded-lg border border-input-border bg-input px-3 text-ui-base text-foreground outline-none hover:border-input-border-hover focus-visible:border-input-border-focused focus-visible:bg-input-focused";
type CatalogView =
  | { kind: "resources" | "create-lake" | "create-resource" | "add-resource" }
  | { kind: "ssh"; resourceId: string };

interface LakeCatalogPageProps {
  onBack: () => void;
  isDesktop: boolean;
  initialLakeId?: string | null;
  initialResourceId?: string | null;
  workspaceTabs?: Array<{ workspacePath: string; workspaceIdentity?: string; label: string }>;
}

export function LakeCatalogPage({
  onBack,
  isDesktop,
  initialLakeId,
  initialResourceId,
  workspaceTabs = [],
}: LakeCatalogPageProps) {
  const { locale } = useZCodeIntl();
  const t = lakeCatalogCopy[locale];
  const service = useBaseWorkspaceServices().lakeCatalogService;
  const platform = usePlatform();
  const [lakes, setLakes] = useState<Lake[]>([]);
  const [allResources, setAllResources] = useState<LakeResource[]>([]);
  const [lakeResources, setLakeResources] = useState<LakeResource[]>([]);
  const [selectedLakeId, setSelectedLakeId] = useState<string | null>(null);
  const [view, setView] = useState<CatalogView>({ kind: "resources" });
  const [lakeName, setLakeName] = useState("");
  const [lakeDescription, setLakeDescription] = useState("");
  const [lakeWorkspacePath, setLakeWorkspacePath] = useState("");
  const [lakeWorkspaceIdentity, setLakeWorkspaceIdentity] = useState<string | undefined>();
  const [resourceName, setResourceName] = useState("");
  const [resourceDescription, setResourceDescription] = useState("");
  const [kind, setKind] = useState<LakeResourceKind>("service");
  const [environment, setEnvironment] = useState<LakeResourceEnvironment>("production");
  const [existingResourceId, setExistingResourceId] = useState("");
  const [loading, setLoading] = useState(true);
  const [resourcesLoading, setResourcesLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    if (initialLakeId) setSelectedLakeId(initialLakeId);
  }, [initialLakeId]);

  const chooseLocalDirectory = async () => {
    const path = await platform.selectDirectory();
    if (path) {
      setLakeWorkspacePath(path);
      setLakeWorkspaceIdentity(undefined);
    }
  };

  const refresh = useCallback(async () => {
    const [nextLakes, nextResources] = await Promise.all([
      service.listLakes(),
      service.listResources(),
    ]);
    setLakes(nextLakes);
    setAllResources(nextResources);
    setSelectedLakeId((current) =>
      current && nextLakes.some((lake) => lake.id === current)
        ? current
        : (nextLakes[0]?.id ?? null),
    );
    setRevision((value) => value + 1);
  }, [service]);

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        await refresh();
        if (active) setError(null);
      } catch (cause) {
        if (active) setError(`${t.loadFailed}: ${String(cause)}`);
      } finally {
        if (active) setLoading(false);
      }
    };
    void load();
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    return () => {
      active = false;
      window.removeEventListener("focus", onFocus);
    };
  }, [refresh, t.loadFailed]);

  useEffect(() => {
    let active = true;
    // 切换湖时旧资源投影已经失效，先清空，避免异步读取期间把上一座湖的资源短暂展示在新标题下。
    setLakeResources([]);
    if (!selectedLakeId) {
      setResourcesLoading(false);
      return () => undefined;
    }
    setResourcesLoading(true);
    void service.listLakeResources(selectedLakeId).then(
      (resources) => {
        if (active) {
          setLakeResources(resources);
          setResourcesLoading(false);
        }
      },
      (cause: unknown) => {
        if (active) {
          setError(`${t.loadFailed}: ${String(cause)}`);
          setResourcesLoading(false);
        }
      },
    );
    return () => {
      active = false;
    };
  }, [revision, selectedLakeId, service, t.loadFailed]);

  const selectedLake = lakes.find((lake) => lake.id === selectedLakeId) ?? null;
  const availableResources = useMemo(() => {
    const memberIds = new Set(lakeResources.map((resource) => resource.id));
    return allResources.filter((resource) => !memberIds.has(resource.id));
  }, [allResources, lakeResources]);
  const selectedSshResource =
    view.kind === "ssh"
      ? (lakeResources.find(
          (resource) => resource.id === view.resourceId && resource.kind === "host",
        ) ?? null)
      : null;

  const save = async (operation: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await operation();
      await refresh();
      notifyLakeCatalogChanged();
    } catch (cause) {
      setError(`${t.saveFailed}: ${cause instanceof Error ? cause.message : String(cause)}`);
    } finally {
      setBusy(false);
    }
  };

  const createLake = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!lakeWorkspacePath) {
      setError(t.chooseProjectFirst);
      return;
    }
    void save(async () => {
      const lake = await service.createLake({
        name: lakeName,
        description: lakeDescription,
        workspacePath: lakeWorkspacePath,
        workspaceIdentity: lakeWorkspaceIdentity,
      });
      setLakeName("");
      setLakeDescription("");
      setLakeWorkspacePath("");
      setLakeWorkspaceIdentity(undefined);
      setSelectedLakeId(lake.id);
      setView({ kind: "resources" });
    });
  };

  const bindSelectedLake = () => {
    if (!selectedLake || !lakeWorkspacePath) {
      setError(t.chooseProjectFirst);
      return;
    }
    void save(async () => {
      await service.bindLakeWorkspace(selectedLake.id, {
        workspacePath: lakeWorkspacePath,
        workspaceIdentity: lakeWorkspaceIdentity,
      });
      setLakeWorkspacePath("");
      setLakeWorkspaceIdentity(undefined);
    });
  };

  const createResource = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selectedLakeId) return;
    void save(async () => {
      await service.createResourceInLake(selectedLakeId, {
        name: resourceName,
        kind,
        environment,
        description: resourceDescription,
      });
      setResourceName("");
      setResourceDescription("");
      setView({ kind: "resources" });
    });
  };

  const addExisting = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selectedLakeId || !existingResourceId) return;
    void save(async () => {
      await service.addResourceToLake(selectedLakeId, existingResourceId);
      setExistingResourceId("");
      setView({ kind: "resources" });
    });
  };

  const workspaceBindingField = (
    <div className="space-y-2">
      <span className="block text-ui-sm font-medium text-foreground-subtle">
        {t.projectDirectory}
      </span>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          size="lg"
          onClick={() => void chooseLocalDirectory()}
        >
          <FolderOpen className="size-4" aria-hidden="true" />
          {t.chooseProjectDirectory}
        </Button>
        {workspaceTabs.length > 0 ? (
          <select
            className={cn(selectClass, "max-w-sm")}
            aria-label={t.chooseOpenProject}
            value={workspaceTabs.findIndex(
              (tab) =>
                tab.workspacePath === lakeWorkspacePath &&
                tab.workspaceIdentity === lakeWorkspaceIdentity,
            )}
            onChange={(event) => {
              const tab = workspaceTabs[Number(event.target.value)];
              if (tab) {
                setLakeWorkspacePath(tab.workspacePath);
                setLakeWorkspaceIdentity(tab.workspaceIdentity);
              }
            }}
          >
            <option value={-1}>{t.chooseOpenProject}</option>
            {workspaceTabs.map((tab, index) => (
              <option key={`${tab.workspaceIdentity ?? tab.workspacePath}:${index}`} value={index}>
                {tab.label}
              </option>
            ))}
          </select>
        ) : null}
      </div>
      {lakeWorkspacePath ? (
        <p className="break-all rounded-lg bg-muted px-3 py-2 font-mono text-ui-sm text-foreground-subtle">
          {lakeWorkspacePath}
        </p>
      ) : (
        <p className="text-ui-sm text-foreground-subtle">{t.chooseProjectFirst}</p>
      )}
    </div>
  );

  return (
    <div
      className="mx-auto flex w-full max-w-7xl flex-col gap-5 px-4 py-5 md:px-6 md:py-6"
      data-testid="lake-catalog-page"
    >
      <header className="flex items-start gap-3">
        <Button
          variant="ghost"
          size="icon-md"
          type="button"
          onClick={onBack}
          className="mt-0.5 sm:hidden"
          aria-label={t.back}
        >
          <ArrowLeft className="size-4" />
        </Button>
        <div className="min-w-0">
          <p className="text-ui-xs font-medium tracking-wide text-foreground-subtlest">
            {t.catalogEyebrow}
          </p>
          <h1 className="mt-1 text-ui-xl font-semibold text-foreground">{t.title}</h1>
          <p className="mt-1 max-w-3xl text-ui-sm text-foreground-subtle">{t.intro}</p>
        </div>
      </header>

      {error ? (
        <div
          role="alert"
          className="rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-ui-sm text-destructive"
        >
          {error}
        </div>
      ) : null}

      <div className="grid min-h-0 gap-5 md:grid-cols-[minmax(220px,260px)_minmax(0,1fr)]">
        <LakeNavigation
          lakes={lakes}
          selectedLakeId={selectedLakeId}
          activeView={view.kind}
          loading={loading}
          t={t}
          onCreateLake={() => setView({ kind: "create-lake" })}
          onSelectLake={(lakeId) => {
            setSelectedLakeId(lakeId);
            setView({ kind: "resources" });
          }}
        />

        <div className="min-w-0 space-y-4">
          {loading ? <CatalogLoadingState label={t.loading} /> : null}

          {!loading && view.kind === "create-lake" ? (
            <ActionPanel
              title={t.createLake}
              description={t.createLakeIntro}
              backLabel={selectedLake ? t.backToResources : undefined}
              onBack={selectedLake ? () => setView({ kind: "resources" }) : undefined}
            >
              <form onSubmit={createLake} className="space-y-4">
                <label className={fieldClass}>
                  {t.lakeName}
                  <Input
                    size="lg"
                    value={lakeName}
                    onChange={(event) => setLakeName(event.target.value)}
                    required
                    maxLength={100}
                    autoFocus
                  />
                </label>
                <label className={fieldClass}>
                  {t.lakeDescription}
                  <Textarea
                    value={lakeDescription}
                    onChange={(event) => setLakeDescription(event.target.value)}
                    maxLength={1000}
                  />
                </label>
                {workspaceBindingField}
                <div className="flex justify-end border-t border-border pt-4">
                  <Button type="submit" size="lg" disabled={busy}>
                    {busy ? t.saving : t.createLake}
                  </Button>
                </div>
              </form>
            </ActionPanel>
          ) : null}

          {!loading && view.kind === "resources" && selectedLake ? (
            <>
              <LakeOverview
                lake={selectedLake}
                resourceCount={resourcesLoading ? null : lakeResources.length}
                t={t}
                onCreateResource={() => setView({ kind: "create-resource" })}
                onAddResource={() => setView({ kind: "add-resource" })}
              />
              {!selectedLake.workspacePath ? (
                <section className="space-y-3 rounded-xl border border-border bg-surface p-4 md:p-5">
                  <div className="flex gap-3">
                    <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-accent text-icon-blue">
                      <Link2 className="size-4" aria-hidden="true" />
                    </div>
                    <div>
                      <h3 className="text-ui-base font-medium text-foreground">
                        {t.unboundProject}
                      </h3>
                      <p className="mt-0.5 text-ui-sm text-foreground-subtle">
                        {t.bindProjectHint}
                      </p>
                    </div>
                  </div>
                  {workspaceBindingField}
                  <Button
                    type="button"
                    size="lg"
                    disabled={busy || !lakeWorkspacePath}
                    onClick={bindSelectedLake}
                  >
                    {t.bindProject}
                  </Button>
                </section>
              ) : null}
              {resourcesLoading ? (
                <ResourceListLoadingState label={t.loading} />
              ) : (
                <LakeResourceList
                  key={selectedLake.id}
                  resources={lakeResources}
                  selectedResourceId={initialResourceId}
                  isDesktop={isDesktop}
                  onCreateResource={() => setView({ kind: "create-resource" })}
                  onManageSsh={(resourceId) => setView({ kind: "ssh", resourceId })}
                  t={t}
                />
              )}
            </>
          ) : null}

          {!loading && view.kind === "resources" && !selectedLake ? (
            <CatalogEmptyState t={t} onCreateLake={() => setView({ kind: "create-lake" })} />
          ) : null}

          {!loading && view.kind === "create-resource" && selectedLake ? (
            <ActionPanel
              title={t.newResource}
              description={t.newResourceIntro}
              backLabel={t.backToResources}
              onBack={() => setView({ kind: "resources" })}
            >
              <form onSubmit={createResource} className="space-y-4">
                <label className={fieldClass}>
                  {t.resourceName}
                  <Input
                    size="lg"
                    value={resourceName}
                    onChange={(event) => setResourceName(event.target.value)}
                    required
                    maxLength={100}
                    autoFocus
                  />
                </label>
                <div className="grid gap-4 sm:grid-cols-2">
                  <label className={fieldClass}>
                    {t.resourceKind}
                    <select
                      className={selectClass}
                      value={kind}
                      onChange={(event) => setKind(event.target.value as LakeResourceKind)}
                    >
                      {resourceKinds.map((value) => (
                        <option key={value} value={value}>
                          {t[value]}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className={fieldClass}>
                    {t.environment}
                    <select
                      className={selectClass}
                      value={environment}
                      onChange={(event) =>
                        setEnvironment(event.target.value as LakeResourceEnvironment)
                      }
                    >
                      {environments.map((value) => (
                        <option key={value} value={value}>
                          {t[value]}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <label className={fieldClass}>
                  {t.resourceDescription}
                  <Textarea
                    value={resourceDescription}
                    onChange={(event) => setResourceDescription(event.target.value)}
                    maxLength={1000}
                  />
                </label>
                <div className="flex justify-end border-t border-border pt-4">
                  <Button type="submit" size="lg" disabled={busy}>
                    {busy ? t.saving : t.newResource}
                  </Button>
                </div>
              </form>
            </ActionPanel>
          ) : null}

          {!loading && view.kind === "add-resource" && selectedLake ? (
            <ActionPanel
              title={t.existingResource}
              description={t.existingResourceIntro}
              backLabel={t.backToResources}
              onBack={() => setView({ kind: "resources" })}
            >
              <form onSubmit={addExisting} className="space-y-4">
                {availableResources.length === 0 ? (
                  <p className="rounded-lg bg-muted px-4 py-3 text-ui-sm text-foreground-subtle">
                    {t.noExisting}
                  </p>
                ) : (
                  <label className={fieldClass}>
                    {t.selectResource}
                    <select
                      className={selectClass}
                      value={existingResourceId}
                      onChange={(event) => setExistingResourceId(event.target.value)}
                      required
                      autoFocus
                    >
                      <option value="" disabled>
                        {t.selectResource}
                      </option>
                      {availableResources.map((resource) => (
                        <option key={resource.id} value={resource.id}>
                          {resource.name} · {t[resource.kind]} · {t[resource.environment]}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <div className="flex justify-end border-t border-border pt-4">
                  <Button type="submit" size="lg" disabled={busy || !existingResourceId}>
                    {busy ? t.saving : t.addToLake}
                  </Button>
                </div>
              </form>
            </ActionPanel>
          ) : null}

          {!loading && view.kind === "ssh" && isDesktop && selectedSshResource ? (
            <div className="space-y-3">
              <Button
                type="button"
                variant="ghost"
                size="lg"
                onClick={() => setView({ kind: "resources" })}
              >
                <ArrowLeft className="size-4" aria-hidden="true" />
                {t.backToResources}
              </Button>
              <LakeSshPanel key={selectedSshResource.id} resource={selectedSshResource} />
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
