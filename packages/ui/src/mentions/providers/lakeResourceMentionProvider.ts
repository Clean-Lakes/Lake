import { useEffect, useMemo, useState } from "react";
import type { Lake, LakeResource } from "@zcode/services";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { lakeCatalogCopy } from "@/lake-catalog/lakeCatalogCopy.js";
import { filterMentionItemsWithOptions } from "@/mentions/mentionSearch.js";
import type { MentionCategoryResult, MentionItem } from "@/mentions/mentionTypes.js";

type LakeIdentity = Pick<Lake, "id" | "name">;

function compactText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** 资源只是人工登记的资产，不在引用中暗示已经连接、监控或授权访问。 */
export function formatLakeResourceMention(
  lake: LakeIdentity,
  resource: LakeResource,
  locale: "zh-CN" | "en-US" = "zh-CN",
): string {
  if (locale === "en-US") {
    return `Lake resource "${compactText(resource.name)}" [lake: ${compactText(lake.name)}; type: ${resource.kind}; environment: ${resource.environment}; description: ${compactText(resource.description) || "none"}; lake ID: ${lake.id}; resource ID: ${resource.id}; registered information only, not live status]`;
  }
  return `湖资源「${compactText(resource.name)}」〔湖：${compactText(lake.name)}；类型：${resource.kind}；环境：${resource.environment}；说明：${compactText(resource.description) || "无"}；湖ID：${lake.id}；资源ID：${resource.id}；仅为登记信息，非实时状态〕`;
}

export function mapLakeResourcesToMentionItems(
  lake: LakeIdentity,
  resources: readonly LakeResource[],
  query: string,
  formatDescription: (resource: LakeResource) => string = (resource) =>
    `${resource.kind} · ${resource.environment}`,
  locale: "zh-CN" | "en-US" = "zh-CN",
): MentionItem[] {
  const items = resources.map<MentionItem>((resource) => ({
    id: `lake-resource:${lake.id}:${resource.id}`,
    category: "lake-resources",
    label: resource.name,
    description: formatDescription(resource),
    value: resource.id,
    markdown: formatLakeResourceMention(lake, resource, locale),
    keywords: [resource.description, resource.kind, resource.environment],
  }));
  return filterMentionItemsWithOptions(items, query);
}

export function useLakeResourceMentionProvider(
  workspacePath: string,
  workspaceIdentity: string | undefined,
  query: string,
  enabled: boolean,
  labels: { title: string; empty: string; noLake: string },
): MentionCategoryResult {
  const { lakeCatalogService } = useBaseWorkspaceServices();
  const { locale } = useZCodeIntl();
  const copy = lakeCatalogCopy[locale];
  const scope = useMemo(
    () => ({ workspaceKey: workspaceIdentity?.trim() || workspacePath }),
    [workspaceIdentity, workspacePath],
  );
  const [result, setResult] = useState<{
    scope: typeof scope;
    lake: LakeIdentity | null;
    resources: LakeResource[];
    error: Error | null;
  } | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    setResult(null);
    const load = async () => {
      try {
        const lake = await lakeCatalogService.getLakeForWorkspace(workspacePath, workspaceIdentity);
        const resources = lake ? await lakeCatalogService.listLakeResources(lake.id) : [];
        if (active) setResult({ scope, lake, resources, error: null });
      } catch (error) {
        if (active) {
          setResult({
            scope,
            lake: null,
            resources: [],
            error: error instanceof Error ? error : new Error(String(error)),
          });
        }
      }
    };
    void load();
    return () => {
      active = false;
    };
  }, [enabled, lakeCatalogService, scope, workspaceIdentity, workspacePath]);

  const current = enabled && result?.scope === scope ? result : null;
  const items = useMemo(
    () =>
      current?.lake
        ? mapLakeResourcesToMentionItems(
            current.lake,
            current.resources,
            query,
            (resource) => `${copy[resource.kind]} · ${copy[resource.environment]}`,
            locale,
          )
        : [],
    [copy, current, locale, query],
  );
  return {
    items,
    loading: enabled && !current,
    error: current?.error ?? null,
    title: labels.title,
    emptyText: current && !current.lake && !current.error ? labels.noLake : labels.empty,
  };
}
