import type { WorkspaceTabState } from "@/store/tabStore.js";

/** 侧栏只投影已绑定湖的工作区；展示名来自湖，执行身份仍由原 tab 保持。 */
export function projectBoundLakeWorkspaceTabs(
  tabs: readonly WorkspaceTabState[],
  lakeNameByWorkspaceKey: ReadonlyMap<string, string>,
): WorkspaceTabState[] {
  return tabs.flatMap((tab) => {
    const workspaceKey = tab.workspaceIdentity?.trim() || tab.workspacePath;
    const lakeName = lakeNameByWorkspaceKey.get(workspaceKey);
    return lakeName === undefined ? [] : [{ ...tab, label: lakeName }];
  });
}
