const key = 'lake.workspace-project';
declare global { interface Window { lakeWorkspaceProjectId?: string; } }

function projectId(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && !/\s|\0/.test(value) ? value : null;
}

export function savedWorkspaceProject(): string | null {
  const native = projectId(window.lakeWorkspaceProjectId);
  if (native) return native;
  try { return projectId(localStorage.getItem(key)); } catch { return null; }
}

export function saveWorkspaceProject(value: string) {
  const id = projectId(value);
  if (!id) return;
  window.lakeWorkspaceProjectId = id;
  try { localStorage.setItem(key, id); } catch {}
  // Desktop loopback ports change between kernel launches. The native host
  // stores this non-secret preference outside the web origin, per app bundle.
  const host = window as Window & {webkit?: {messageHandlers?: {lakeChrome?: {postMessage: (body: unknown) => void}}}};
  try { host.webkit?.messageHandlers?.lakeChrome?.postMessage({workspaceProjectId: id}); } catch {}
}
