import type {Catalog, WorkSession} from "../../shared/contracts";
import {isWorkspacePageView, type WorkspaceRoute} from "./workspaceRoute";

type WorkspaceCatalog = Pick<Catalog, "projects" | "resources" | "sessions">;

export function isUserWorkspaceSession({workspaceRole}: Pick<WorkSession, "workspaceRole">) {
  return workspaceRole === undefined || workspaceRole === "router" || workspaceRole === "legacy";
}

export function defaultWorkspaceSession(sessions: WorkSession[], projectId: string | null) {
  const candidates = sessions.filter(session => session.projectId === projectId && isUserWorkspaceSession(session));
  candidates.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return candidates.find(session => session.workspaceRole === "router") ?? candidates[0];
}

export function initialSidebarProject(catalog: WorkspaceCatalog, route: WorkspaceRoute, savedProjectId?: string | null) {
  const resource = catalog.resources.find(item => item.id === route.resourceId);
  const session = catalog.sessions.find(item => item.id === route.sessionId && item.workspaceRole !== 'conversation');
  const saved = catalog.projects.find(item => item.id === savedProjectId);
  const recent = catalog.sessions.filter(isUserWorkspaceSession).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  return resource?.projectId ?? session?.projectId ?? saved?.id ?? recent?.projectId ?? catalog.projects[0]?.id;
}

export function initialWorkspaceSelection(catalog: WorkspaceCatalog, route: WorkspaceRoute, savedProjectId?: string | null) {
  const projectId = initialSidebarProject(catalog, route, savedProjectId) ?? null;
  const session = catalog.sessions.find(item => item.projectId === projectId && item.id === route.sessionId && item.workspaceRole !== 'conversation')
    ?? defaultWorkspaceSession(catalog.sessions, projectId);
  const resource = catalog.resources.find(item => item.id === route.resourceId && item.projectId === projectId);
  const sessionId = session?.id ?? null;
  const canShowPlans = sessionId === route.sessionId && session && isUserWorkspaceSession(session) && !resource;
  return {projectId, route: {
    sessionId, resourceId: resource?.id ?? null,
    ...(isWorkspacePageView(route.view) ? {view:route.view, ...(route.returnView && canShowPlans ? {returnView:route.returnView} : {})} :
      route.view === 'plans' && canShowPlans ? {view:'plans' as const} : {}),
  }};
}

export function sidebarSessions(sessions: WorkSession[], selectedId: string | null, showAll: boolean) {
  if (showAll || sessions.length <= 5) return sessions;
  const recent = sessions.slice(0, 5);
  const selected = sessions.find(item => item.id === selectedId);
  return selected && !recent.includes(selected) ? [...recent.slice(0, 4), selected] : recent;
}
