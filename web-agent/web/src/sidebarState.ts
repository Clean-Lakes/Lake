import type {Catalog, WorkSession} from "../../shared/contracts";
import type {WorkspaceRoute} from "./workspaceRoute";

type WorkspaceCatalog = Pick<Catalog, "projects" | "resources" | "sessions">;

export function initialSidebarProject(catalog: WorkspaceCatalog, route: WorkspaceRoute, savedProjectId?: string | null) {
  const resource = catalog.resources.find(item => item.id === route.resourceId);
  const session = catalog.sessions.find(item => item.id === route.sessionId);
  const saved = catalog.projects.find(item => item.id === savedProjectId);
  const recent = [...catalog.sessions].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  return resource?.projectId ?? session?.projectId ?? saved?.id ?? recent?.projectId ?? catalog.projects[0]?.id;
}

export function initialWorkspaceSelection(catalog: WorkspaceCatalog, route: WorkspaceRoute, savedProjectId?: string | null) {
  const projectId = initialSidebarProject(catalog, route, savedProjectId) ?? null;
  const sessions = catalog.sessions.filter(item => item.projectId === projectId);
  const session = sessions.find(item => item.id === route.sessionId)
    ?? [...sessions].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  const resource = catalog.resources.find(item => item.id === route.resourceId && item.projectId === projectId);
  const sessionId = session?.id ?? null;
  return {projectId, route: {
    sessionId, resourceId: resource?.id ?? null,
    ...(route.view === 'plans' && sessionId === route.sessionId && !resource ? {view: 'plans' as const} : {}),
  }};
}

export function sidebarSessions(sessions: WorkSession[], selectedId: string | null, showAll: boolean) {
  if (showAll || sessions.length <= 5) return sessions;
  const recent = sessions.slice(0, 5);
  const selected = sessions.find(item => item.id === selectedId);
  return selected && !recent.includes(selected) ? [...recent.slice(0, 4), selected] : recent;
}
