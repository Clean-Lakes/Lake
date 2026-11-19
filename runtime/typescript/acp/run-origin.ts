import { realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ExternalRun } from './types';

function isPathComponent(value: string) {
  return !!value && value !== '.' && value !== '..' && !/[\\/\0]/.test(value);
}

/** Older runs lack runtimeKind. The pinned CLI indexes the originating client and cwd by thread ID. */
export function resolveCodexRunOrigins(home: string, data: string, projectId: string, runs: ExternalRun[]): ExternalRun[] {
  const candidates = runs.filter(run => run.projectId === projectId && run.agent === 'codex' &&
    !run.runtimeKind && run.externalSessionId && isPathComponent(run.contextId));
  if (!candidates.length || !isPathComponent(projectId)) return runs;

  let db: DatabaseSync | undefined;
  const verified = new Set<string>();
  try {
    const file = join(realpathSync(home), 'external-agents', 'profiles', projectId, 'codex', 'state', 'state_5.sqlite');
    if (realpathSync(file) !== file) return runs;
    db = new DatabaseSync(file, { readOnly: true });
    const lookup = db.prepare("SELECT 1 FROM threads WHERE id = ? AND originator = 'lake' AND cwd = ?");
    for (const run of candidates) {
      const cwd = resolve(data, 'external-agents', 'runs', run.contextId);
      if (lookup.get(run.externalSessionId!, cwd)) verified.add(run.id);
    }
  } catch {
    // The CLI index may be absent, unreadable, or from a different schema.
  } finally {
    db?.close();
  }
  return runs.map(run => verified.has(run.id) ? { ...run, runtimeKind: 'codex-app-server' } : run);
}
