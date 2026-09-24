import type { LakeResource, LakeResourceEnvironment, LakeResourceKind } from "@zcode/services";

export type LakeResourceKindFilter = "all" | LakeResourceKind;
export type LakeResourceEnvironmentFilter = "all" | LakeResourceEnvironment;

export interface LakeResourceFilters {
  query: string;
  kind: LakeResourceKindFilter;
  environment: LakeResourceEnvironmentFilter;
}

export interface LakeResourceSummary {
  total: number;
  byKind: Record<LakeResourceKind, number>;
  byEnvironment: Record<LakeResourceEnvironment, number>;
}

export function filterLakeResources(
  resources: readonly LakeResource[],
  filters: LakeResourceFilters,
): LakeResource[] {
  const query = filters.query.trim().toLocaleLowerCase();
  return resources.filter((resource) => {
    if (filters.kind !== "all" && resource.kind !== filters.kind) return false;
    if (filters.environment !== "all" && resource.environment !== filters.environment) return false;
    if (!query) return true;
    return `${resource.name}\n${resource.description}`.toLocaleLowerCase().includes(query);
  });
}

export function summarizeLakeResources(resources: readonly LakeResource[]): LakeResourceSummary {
  const summary: LakeResourceSummary = {
    total: resources.length,
    byKind: {
      service: 0,
      host: 0,
      "kubernetes-cluster": 0,
      database: 0,
    },
    byEnvironment: {
      production: 0,
      staging: 0,
      development: 0,
      other: 0,
    },
  };
  for (const resource of resources) {
    summary.byKind[resource.kind] += 1;
    summary.byEnvironment[resource.environment] += 1;
  }
  return summary;
}
