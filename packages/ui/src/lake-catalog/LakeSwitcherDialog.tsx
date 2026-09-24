import { useEffect, useMemo, useState } from "react";
import { Folder, MessageCircle, Waves } from "lucide-react";
import type { Lake, LakeResource } from "@zcode/services";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command.js";
import { useGlobalTaskList } from "@/hooks/useGlobalTaskList.js";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { WorkspaceTabState } from "@/store/tabStore.js";
import { logger } from "@/logger.js";

type SwitcherScope = "sessions" | "lakes" | "resources";
type ResourceInLake = { lake: Lake; resource: LakeResource };

export function LakeSwitcherDialog({
  open,
  onOpenChange,
  onSelectLake,
  onSelectTask,
  onCreateSession,
  onSelectResource,
  onOpenCatalog,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelectLake: (lake: Lake) => void;
  onSelectTask: (workspacePath: string, taskId: string, workspaceIdentity?: string) => void;
  onCreateSession: (lake: Lake) => void;
  onSelectResource: (lakeId: string, resourceId: string) => void;
  onOpenCatalog: () => void;
}) {
  const { locale } = useZCodeIntl();
  const service = useBaseWorkspaceServices().lakeCatalogService;
  const [scope, setScope] = useState<SwitcherScope>("sessions");
  const [query, setQuery] = useState("");
  const [lakes, setLakes] = useState<Lake[]>([]);
  const [resources, setResources] = useState<ResourceInLake[]>([]);
  const [expandedLakeId, setExpandedLakeId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selectedLake = lakes.find((lake) => lake.id === expandedLakeId) ?? null;
  const sessionWorkspaceTabs = useMemo<WorkspaceTabState[]>(
    () =>
      open && scope === "sessions" && selectedLake?.workspacePath
        ? [
            {
              kind: "workspace",
              id: selectedLake.id,
              label: selectedLake.name,
              workspacePath: selectedLake.workspacePath,
              ...(selectedLake.workspaceIdentity
                ? { workspaceIdentity: selectedLake.workspaceIdentity }
                : {}),
            },
          ]
        : [],
    [open, scope, selectedLake],
  );
  const taskList = useGlobalTaskList({
    kind: "active",
    workspaceTabs: sessionWorkspaceTabs,
    sortBy: "updated",
    searchQuery: query,
    expanded: true,
    collapsedLimit: 80,
  });

  useEffect(() => {
    if (!open) return;
    let active = true;
    setScope("sessions");
    setQuery("");
    setExpandedLakeId(null);
    setError(null);
    setLoading(true);
    void service
      .listLakes()
      .then(
        (items) => {
          if (active) setLakes(items);
        },
        (cause: unknown) => {
          logger.warn("[LakeSwitcher] 加载湖失败", { cause });
          if (active) setError(String(cause));
        },
      )
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [open, service]);

  useEffect(() => {
    if (!open || scope !== "resources") return;
    let active = true;
    setLoading(true);
    void Promise.all(
      lakes.map(async (lake) =>
        (await service.listLakeResources(lake.id)).map((resource) => ({ lake, resource })),
      ),
    )
      .then(
        (groups) => {
          if (active) setResources(groups.flat());
        },
        (cause: unknown) => {
          logger.warn("[LakeSwitcher] 加载资源失败", { cause });
          if (active) setError(String(cause));
        },
      )
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [lakes, open, scope, service]);

  const labels =
    locale === "en-US"
      ? {
          title: "Lake switcher",
          sessions: "Sessions",
          lakes: "Lakes",
          resources: "Resources",
          search: "Search within this list…",
          empty: "Nothing here yet",
          loading: "Loading…",
          newSession: "New session in this lake",
          create: "Create or bind a lake",
          unbound: "Bind a project directory to open sessions",
          back: "Back to lakes",
        }
      : {
          title: "湖快速切换",
          sessions: "会话",
          lakes: "湖",
          resources: "资源",
          search: "搜索当前列表…",
          empty: "暂无内容",
          loading: "正在加载…",
          newSession: "在此湖新建会话",
          create: "创建或绑定湖",
          unbound: "绑定项目目录后才能展开会话",
          back: "返回湖列表",
        };
  const needle = query.trim().toLocaleLowerCase();
  const matches = (value: string) => value.toLocaleLowerCase().includes(needle);

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title={labels.title}
      description={labels.title}
      className="top-16 max-w-xl translate-y-0 border-popover-border bg-popover p-0 shadow-md"
    >
      <Command shouldFilter={false} className="rounded-xl bg-popover">
        <CommandInput value={query} onValueChange={setQuery} placeholder={labels.search} />
        <div role="tablist" className="flex gap-1 border-b border-border px-2 py-1">
          {(["sessions", "lakes", "resources"] as const).map((value) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={scope === value}
              className={`rounded-md px-2 py-1 text-ui-base ${scope === value ? "bg-selected text-foreground" : "text-foreground-subtle hover:bg-surface-hover"}`}
              onClick={() => {
                setScope(value);
                setQuery("");
                setExpandedLakeId(null);
              }}
            >
              {labels[value]}
            </button>
          ))}
        </div>
        <CommandList className="max-h-[min(440px,65vh)]">
          {error ? (
            <p role="alert" className="p-3 text-ui-sm text-destructive">
              {error}
            </p>
          ) : null}
          {loading ? (
            <p className="p-3 text-ui-sm text-foreground-subtle">{labels.loading}</p>
          ) : null}
          {scope === "sessions" && expandedLakeId ? (
            <CommandItem
              value="back-to-lakes"
              onSelect={() => {
                setExpandedLakeId(null);
                setQuery("");
              }}
            >
              <Waves className="mr-2 size-4" />
              {labels.back}
            </CommandItem>
          ) : null}
          {scope === "sessions" && selectedLake?.workspacePath ? (
            <CommandItem
              value="new-session-in-lake"
              onSelect={() => {
                onCreateSession(selectedLake);
                onOpenChange(false);
              }}
            >
              <MessageCircle className="mr-2 size-4" />
              {labels.newSession}
            </CommandItem>
          ) : null}
          {scope === "sessions" && !expandedLakeId
            ? lakes
                .filter((lake) => matches(lake.name))
                .map((lake) => (
                  <CommandItem
                    key={lake.id}
                    value={lake.id}
                    onSelect={() => {
                      if (lake.workspacePath) {
                        setExpandedLakeId(lake.id);
                        setQuery("");
                      } else {
                        onSelectResource(lake.id, "");
                        onOpenChange(false);
                      }
                    }}
                  >
                    <Waves className="mr-2 size-4" />
                    <span className="min-w-0 flex-1 truncate">{lake.name}</span>
                    {!lake.workspacePath ? (
                      <span className="text-ui-sm text-foreground-subtle">{labels.unbound}</span>
                    ) : null}
                  </CommandItem>
                ))
            : null}
          {scope === "sessions" && expandedLakeId
            ? taskList.items.map((task) => (
                <CommandItem
                  key={task.taskId}
                  value={task.taskId}
                  onSelect={() => {
                    onSelectTask(task.workspacePath, task.taskId, task.workspaceIdentity);
                    onOpenChange(false);
                  }}
                >
                  <MessageCircle className="mr-2 size-4" />
                  <span className="truncate">{task.title || task.taskId}</span>
                </CommandItem>
              ))
            : null}
          {scope === "sessions" &&
          expandedLakeId &&
          !taskList.loading &&
          taskList.items.length === 0 ? (
            <p className="p-3 text-ui-sm text-foreground-subtle">{labels.empty}</p>
          ) : null}
          {scope === "lakes"
            ? lakes
                .filter((lake) => matches(lake.name))
                .map((lake) => (
                  <CommandItem
                    key={lake.id}
                    value={lake.id}
                    onSelect={() => {
                      onSelectLake(lake);
                      onOpenChange(false);
                    }}
                  >
                    <Waves className="mr-2 size-4" />
                    {lake.name}
                  </CommandItem>
                ))
            : null}
          {scope === "resources"
            ? resources
                .filter(({ resource, lake }) => matches(`${resource.name} ${lake.name}`))
                .map(({ resource, lake }) => (
                  <CommandItem
                    key={`${lake.id}:${resource.id}`}
                    value={`${lake.id}:${resource.id}`}
                    onSelect={() => {
                      onSelectResource(lake.id, resource.id);
                      onOpenChange(false);
                    }}
                  >
                    <Folder className="mr-2 size-4" />
                    <span className="min-w-0 flex-1 truncate">{resource.name}</span>
                    <span className="text-ui-sm text-foreground-subtle">{lake.name}</span>
                  </CommandItem>
                ))
            : null}
          <CommandEmpty>{labels.empty}</CommandEmpty>
          {scope === "lakes" || (scope === "sessions" && !expandedLakeId) ? (
            <CommandItem
              value="create-lake"
              onSelect={() => {
                onOpenCatalog();
                onOpenChange(false);
              }}
            >
              <Waves className="mr-2 size-4" />
              {labels.create}
            </CommandItem>
          ) : null}
        </CommandList>
      </Command>
    </CommandDialog>
  );
}
