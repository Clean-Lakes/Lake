import type { ReactNode } from "react";
import { ArrowLeft, ChevronRight, FolderOpen, Plus, Waves } from "lucide-react";
import type { Lake } from "@zcode/services";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { lakeCatalogCopy } from "./lakeCatalogCopy.js";

type CatalogCopy = (typeof lakeCatalogCopy)[keyof typeof lakeCatalogCopy];

export function LakeNavigation({
  lakes,
  selectedLakeId,
  activeView,
  loading,
  t,
  onCreateLake,
  onSelectLake,
}: {
  lakes: Lake[];
  selectedLakeId: string | null;
  activeView: "resources" | "create-lake" | "create-resource" | "add-resource" | "ssh";
  loading: boolean;
  t: CatalogCopy;
  onCreateLake: () => void;
  onSelectLake: (lakeId: string) => void;
}) {
  return (
    <aside className="min-w-0 md:sticky md:top-0 md:self-start" aria-label={t.lakeNavigation}>
      <section className="overflow-hidden rounded-xl border border-card-border bg-card">
        <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-3">
          <div className="min-w-0">
            <h2 className="text-ui-base font-semibold text-foreground">{t.lakes}</h2>
            <p className="text-ui-xs text-foreground-subtle">{t.lakeCount(lakes.length)}</p>
          </div>
          <Button
            type="button"
            variant={activeView === "create-lake" ? "secondary" : "ghost"}
            size="icon-md"
            aria-label={t.createLake}
            aria-pressed={activeView === "create-lake"}
            onClick={onCreateLake}
          >
            <Plus className="size-4" aria-hidden="true" />
          </Button>
        </div>
        {loading ? (
          <div className="space-y-2 p-3" aria-label={t.loading}>
            <div className="h-12 animate-pulse rounded-lg bg-muted" />
            <div className="h-12 animate-pulse rounded-lg bg-muted" />
          </div>
        ) : lakes.length === 0 ? (
          <p className="px-3 py-4 text-ui-sm text-foreground-subtle">{t.emptyLakes}</p>
        ) : (
          <div className="flex gap-1 overflow-x-auto p-2 md:flex-col md:overflow-visible">
            {lakes.map((lake) => {
              const selected = selectedLakeId === lake.id && activeView !== "create-lake";
              return (
                <button
                  key={lake.id}
                  type="button"
                  aria-current={selected ? "page" : undefined}
                  onClick={() => onSelectLake(lake.id)}
                  className={cn(
                    "group flex min-w-52 items-center gap-2 rounded-lg px-2.5 py-2 text-left outline-none transition-colors hover:bg-hover focus-visible:bg-hover md:min-w-0",
                    selected && "bg-selected",
                  )}
                >
                  <span
                    className={cn(
                      "flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-foreground-subtle",
                      selected && "bg-accent text-icon-blue",
                    )}
                  >
                    <Waves className="size-4" aria-hidden="true" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-ui-base font-medium text-foreground">
                      {lake.name}
                    </span>
                    <span className="block truncate text-ui-xs text-foreground-subtlest">
                      {lake.workspacePath ?? t.unboundProject}
                    </span>
                  </span>
                  <ChevronRight
                    className="size-3.5 shrink-0 text-foreground-subtlest md:opacity-0 md:group-hover:opacity-100"
                    aria-hidden="true"
                  />
                </button>
              );
            })}
          </div>
        )}
      </section>
    </aside>
  );
}

export function LakeOverview({
  lake,
  resourceCount,
  t,
  onCreateResource,
  onAddResource,
}: {
  lake: Lake;
  resourceCount: number | null;
  t: CatalogCopy;
  onCreateResource: () => void;
  onAddResource: () => void;
}) {
  return (
    <section className="rounded-xl border border-card-border bg-card p-4 md:p-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 gap-3">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-accent text-icon-blue">
            <Waves className="size-5" aria-hidden="true" />
          </div>
          <div className="min-w-0">
            <p className="text-ui-xs font-medium text-foreground-subtlest">{t.currentLake}</p>
            <h2 className="mt-0.5 truncate text-ui-lg font-semibold text-foreground">
              {lake.name}
            </h2>
            <p className="mt-1 max-w-2xl text-ui-sm text-foreground-subtle">
              {lake.description || t.noResourceDescription}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" size="lg" onClick={onAddResource}>
            {t.existingResource}
          </Button>
          <Button type="button" size="lg" onClick={onCreateResource}>
            <Plus className="size-4" aria-hidden="true" />
            {t.newResource}
          </Button>
        </div>
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-border pt-3 text-ui-sm text-foreground-subtle">
        <span className="font-medium text-foreground">
          {resourceCount === null ? t.loading : t.resourceResults(resourceCount, resourceCount)}
        </span>
        <span className="flex min-w-0 items-center gap-1.5">
          <FolderOpen className="size-3.5 shrink-0" aria-hidden="true" />
          <span className="shrink-0">{lake.workspacePath ? t.boundProject : t.unboundProject}</span>
          {lake.workspacePath ? (
            <span className="max-w-xl truncate font-mono text-ui-xs" title={lake.workspacePath}>
              {lake.workspacePath}
            </span>
          ) : null}
        </span>
      </div>
    </section>
  );
}

export function ActionPanel({
  title,
  description,
  backLabel,
  onBack,
  children,
}: {
  title: string;
  description: string;
  backLabel?: string;
  onBack?: () => void;
  children: ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-xl border border-card-border bg-card">
      <div className="border-b border-border px-4 py-4 md:px-5">
        {onBack && backLabel ? (
          <Button type="button" variant="ghost" size="sm" className="mb-2 -ml-2" onClick={onBack}>
            <ArrowLeft className="size-3.5" aria-hidden="true" />
            {backLabel}
          </Button>
        ) : null}
        <h2 className="text-ui-lg font-semibold text-foreground">{title}</h2>
        <p className="mt-1 max-w-2xl text-ui-sm text-foreground-subtle">{description}</p>
      </div>
      <div className="max-w-2xl px-4 py-5 md:px-5">{children}</div>
    </section>
  );
}

export function CatalogLoadingState({ label }: { label: string }) {
  return (
    <div className="space-y-3" aria-label={label}>
      <div className="h-36 animate-pulse rounded-xl border border-card-border bg-card" />
      <div className="h-72 animate-pulse rounded-xl border border-card-border bg-card" />
    </div>
  );
}

export function ResourceListLoadingState({ label }: { label: string }) {
  return (
    <div
      className="h-72 animate-pulse rounded-xl border border-card-border bg-card"
      aria-label={label}
    />
  );
}

export function CatalogEmptyState({
  t,
  onCreateLake,
}: {
  t: CatalogCopy;
  onCreateLake: () => void;
}) {
  return (
    <section className="flex min-h-80 flex-col items-center justify-center rounded-xl border border-card-border bg-card px-6 py-12 text-center">
      <div className="mb-4 flex size-12 items-center justify-center rounded-xl bg-accent text-icon-blue">
        <Waves className="size-6" aria-hidden="true" />
      </div>
      <h2 className="text-ui-lg font-semibold text-foreground">{t.createLake}</h2>
      <p className="mt-1 max-w-md text-ui-sm text-foreground-subtle">{t.emptyLakes}</p>
      <Button type="button" size="lg" className="mt-4" onClick={onCreateLake}>
        <Plus className="size-4" aria-hidden="true" />
        {t.createLake}
      </Button>
    </section>
  );
}
