export type UpdateStatusEntryPlacement = "workspace-header-actions" | "top-overlay-fallback";

export function resolveUpdateStatusEntryPlacement(
  hasWorkspaceHeader: boolean,
): UpdateStatusEntryPlacement {
  return hasWorkspaceHeader ? "workspace-header-actions" : "top-overlay-fallback";
}
