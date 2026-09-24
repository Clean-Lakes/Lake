import assert from "node:assert/strict";
import test from "node:test";
import enUS from "../src/i18n/locales/en-US.js";
import zhCN from "../src/i18n/locales/zh-CN.js";
import { projectBoundLakeWorkspaceTabs } from "../src/lib/lakeSidebarWorkspaceTabs.js";
import type { WorkspaceTabState } from "../src/store/tabStore.js";

test("sidebar shows the bound lake name without changing workspace identity or execution path", () => {
  const tabs: WorkspaceTabState[] = [
    { id: "local", kind: "workspace", label: "k8s", workspacePath: "/projects/k8s" },
    {
      id: "remote",
      kind: "workspace",
      label: "remote path",
      workspacePath: "/projects/k8s",
      workspaceIdentity: "ssh:remote-host:/projects/k8s",
    },
    { id: "unbound", kind: "workspace", label: "other", workspacePath: "/projects/other" },
  ];
  const names = new Map([
    ["/projects/k8s", "南京环境"],
    ["ssh:remote-host:/projects/k8s", "远端湖"],
  ]);

  const projected = projectBoundLakeWorkspaceTabs(tabs, names);
  assert.deepEqual(
    projected.map((tab) => tab.label),
    ["南京环境", "远端湖"],
  );
  assert.equal(projected[0]?.workspacePath, "/projects/k8s");
  assert.equal(projected[1]?.workspaceIdentity, "ssh:remote-host:/projects/k8s");
  assert.equal(tabs[0]?.label, "k8s");
});

test("sidebar lake view uses lake language in both locales", () => {
  for (const messages of [zhCN, enUS]) {
    for (const key of [
      "workspaceSidebar.organizeByProject",
      "workspaceSidebar.projectsSection",
      "workspaceSidebar.noProjects",
      "workspaceSidebar.viewByWorkspace",
    ]) {
      assert.match(messages[key] ?? "", /湖|[Ll]ake/);
    }
  }
});
