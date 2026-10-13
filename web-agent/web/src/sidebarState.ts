import type {Catalog, WorkSession} from "../../shared/contracts";

export function initialSidebarProject(catalog: Pick<Catalog, "projects" | "resources" | "sessions">, route: {sessionId: string | null; resourceId: string | null}) {
  const resource = catalog.resources.find(item => item.id === route.resourceId);
  const session = catalog.sessions.find(item => item.id === route.sessionId)
    ?? [...catalog.sessions].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  return resource?.projectId ?? session?.projectId ?? catalog.projects[0]?.id;
}

export function sidebarSessions(sessions: WorkSession[], selectedId: string | null, showAll: boolean) {
  if (showAll || sessions.length <= 5) return sessions;
  const recent = sessions.slice(0, 5);
  const selected = sessions.find(item => item.id === selectedId);
  return selected && !recent.includes(selected) ? [...recent.slice(0, 4), selected] : recent;
}
