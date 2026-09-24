import { useEffect, useMemo, useRef, useState, type ComponentType } from "react";
import {
  Boxes,
  Container,
  Database,
  Layers3,
  Search,
  Server,
  SlidersHorizontal,
} from "lucide-react";
import type { LakeResource, LakeResourceEnvironment, LakeResourceKind } from "@zcode/services";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { lakeCatalogCopy } from "./lakeCatalogCopy.js";
import {
  filterLakeResources,
  summarizeLakeResources,
  type LakeResourceEnvironmentFilter,
  type LakeResourceKindFilter,
} from "./lakeResourceView.js";

const resourceKinds: LakeResourceKind[] = ["service", "host", "kubernetes-cluster", "database"];
const environments: LakeResourceEnvironment[] = ["production", "staging", "development", "other"];
const selectClass =
  "h-9 min-w-0 rounded-lg border border-input-border bg-input px-2 text-ui-base text-foreground outline-none hover:border-input-border-hover focus-visible:border-input-border-focused focus-visible:bg-input-focused";

const kindIcons: Record<LakeResourceKind, ComponentType<{ className?: string }>> = {
  service: Boxes,
  host: Server,
  "kubernetes-cluster": Container,
  database: Database,
};

export function LakeResourceList({
  resources,
  selectedResourceId,
  isDesktop,
  onCreateResource,
  onManageSsh,
  t,
}: {
  resources: LakeResource[];
  selectedResourceId?: string | null;
  isDesktop: boolean;
  onCreateResource: () => void;
  onManageSsh: (resourceId: string) => void;
  t: (typeof lakeCatalogCopy)[keyof typeof lakeCatalogCopy];
}) {
  const [query, setQuery] = useState("");
  const [kindFilter, setKindFilter] = useState<LakeResourceKindFilter>("all");
  const [environmentFilter, setEnvironmentFilter] = useState<LakeResourceEnvironmentFilter>("all");
  const selectedItemRef = useRef<HTMLLIElement | null>(null);
  const summary = useMemo(() => summarizeLakeResources(resources), [resources]);
  const visibleResources = useMemo(
    () =>
      filterLakeResources(resources, {
        query,
        kind: kindFilter,
        environment: environmentFilter,
      }),
    [environmentFilter, kindFilter, query, resources],
  );
  const hasActiveFilters = Boolean(
    query.trim() || kindFilter !== "all" || environmentFilter !== "all",
  );

  useEffect(() => {
    if (selectedResourceId) selectedItemRef.current?.scrollIntoView({ block: "nearest" });
  }, [resources, selectedResourceId]);

  const clearFilters = () => {
    setQuery("");
    setKindFilter("all");
    setEnvironmentFilter("all");
  };

  return (
    <section className="overflow-hidden rounded-xl border border-card-border bg-card">
      <div className="border-b border-border px-4 py-4 md:px-5">
        <div>
          <h3 className="text-ui-base font-semibold text-foreground">{t.resourceList}</h3>
          <p className="mt-0.5 text-ui-sm text-foreground-subtle">
            {t.resourceResults(visibleResources.length, resources.length)}
          </p>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-px border-b border-border bg-border xl:grid-cols-5">
        <SummaryCell
          className="col-span-2 xl:col-span-1"
          label={t.registeredResources}
          value={summary.total}
          icon={Layers3}
        />
        {resourceKinds.map((kind) => (
          <SummaryCell
            key={kind}
            label={t[kind]}
            value={summary.byKind[kind]}
            icon={kindIcons[kind]}
          />
        ))}
      </div>

      {resources.length > 0 ? (
        <div className="grid gap-2 border-b border-border bg-surface px-4 py-3 md:grid-cols-[minmax(220px,1fr)_minmax(140px,190px)_minmax(140px,190px)_auto] md:px-5">
          <label className="relative min-w-0">
            <span className="sr-only">{t.searchResources}</span>
            <Search
              className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-foreground-subtlest"
              aria-hidden="true"
            />
            <Input
              type="search"
              size="lg"
              className="h-9 rounded-lg pl-9 [&::-webkit-search-cancel-button]:appearance-none"
              value={query}
              placeholder={t.searchResources}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <label>
            <span className="sr-only">{t.resourceKind}</span>
            <select
              className={cn(selectClass, "w-full")}
              value={kindFilter}
              onChange={(event) => setKindFilter(event.target.value as LakeResourceKindFilter)}
            >
              <option value="all">{t.allKinds}</option>
              {resourceKinds.map((kind) => (
                <option key={kind} value={kind}>
                  {t[kind]}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span className="sr-only">{t.environment}</span>
            <select
              className={cn(selectClass, "w-full")}
              value={environmentFilter}
              onChange={(event) =>
                setEnvironmentFilter(event.target.value as LakeResourceEnvironmentFilter)
              }
            >
              <option value="all">{t.allEnvironments}</option>
              {environments.map((environment) => (
                <option key={environment} value={environment}>
                  {t[environment]}
                </option>
              ))}
            </select>
          </label>
          <Button
            type="button"
            variant="ghost"
            size="lg"
            disabled={!hasActiveFilters}
            onClick={clearFilters}
          >
            <SlidersHorizontal className="size-4" aria-hidden="true" />
            {t.clearFilters}
          </Button>
        </div>
      ) : null}

      {resources.length === 0 ? (
        <ResourceEmptyState
          title={t.emptyResourcesTitle}
          description={t.emptyResources}
          actionLabel={t.newResource}
          onAction={onCreateResource}
        />
      ) : visibleResources.length === 0 ? (
        <ResourceEmptyState
          title={t.noMatches}
          description={t.noMatchesHint}
          actionLabel={t.clearFilters}
          onAction={clearFilters}
        />
      ) : (
        <ul className="divide-y divide-border" aria-label={t.resources}>
          {visibleResources.map((resource) => {
            const ResourceIcon = kindIcons[resource.kind];
            return (
              <li
                key={resource.id}
                ref={resource.id === selectedResourceId ? selectedItemRef : undefined}
                data-selected={resource.id === selectedResourceId ? "true" : undefined}
                className={cn(
                  "grid grid-cols-[auto_minmax(0,1fr)] gap-3 px-4 py-3.5 transition-colors md:grid-cols-[auto_minmax(0,1fr)_auto] md:px-5",
                  resource.id === selectedResourceId ? "bg-selected" : "hover:bg-surface-hover",
                )}
              >
                <div className="flex size-9 items-center justify-center rounded-lg bg-accent text-icon-blue">
                  <ResourceIcon className="size-4.5" aria-hidden="true" />
                </div>
                <div className="min-w-0 self-center">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-ui-base font-medium text-foreground">
                      {resource.name}
                    </span>
                    <ResourceBadge>{t[resource.kind]}</ResourceBadge>
                    <ResourceBadge>{t[resource.environment]}</ResourceBadge>
                  </div>
                  {resource.description ? (
                    <p className="mt-1 break-words text-ui-sm text-foreground-subtle">
                      {resource.description}
                    </p>
                  ) : (
                    <p className="mt-1 text-ui-sm text-foreground-subtlest">
                      {t.noResourceDescription}
                    </p>
                  )}
                </div>
                {isDesktop && resource.kind === "host" ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="col-start-2 w-fit md:col-start-3 md:row-start-1 md:self-center"
                    onClick={() => onManageSsh(resource.id)}
                  >
                    {t.sshManage}
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function SummaryCell({
  className,
  label,
  value,
  icon: Icon,
}: {
  className?: string;
  label: string;
  value: number;
  icon: ComponentType<{ className?: string }>;
}) {
  return (
    <div className={cn("flex min-w-0 items-center gap-3 bg-card px-4 py-3", className)}>
      <Icon className="size-4 shrink-0 text-foreground-subtlest" aria-hidden="true" />
      <div className="min-w-0">
        <p className="text-ui-lg font-semibold tabular-nums text-foreground">{value}</p>
        <p className="truncate text-ui-xs text-foreground-subtle">{label}</p>
      </div>
    </div>
  );
}

function ResourceBadge({ children }: { children: string }) {
  return (
    <span className="rounded-md bg-muted px-1.5 py-0.5 text-ui-xs text-foreground-subtle">
      {children}
    </span>
  );
}

function ResourceEmptyState({
  title,
  description,
  actionLabel,
  onAction,
}: {
  title: string;
  description: string;
  actionLabel: string;
  onAction: () => void;
}) {
  return (
    <div className="flex min-h-56 flex-col items-center justify-center px-6 py-10 text-center">
      <div className="mb-3 flex size-10 items-center justify-center rounded-xl bg-accent text-icon-blue">
        <Layers3 className="size-5" aria-hidden="true" />
      </div>
      <h4 className="text-ui-base font-medium text-foreground">{title}</h4>
      <p className="mt-1 max-w-md text-ui-sm text-foreground-subtle">{description}</p>
      <Button type="button" variant="outline" size="lg" className="mt-4" onClick={onAction}>
        {actionLabel}
      </Button>
    </div>
  );
}
