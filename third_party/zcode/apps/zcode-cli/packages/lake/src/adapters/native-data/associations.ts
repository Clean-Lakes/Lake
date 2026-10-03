import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import { realpath, stat } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { lakeWorkspaceBindingSchema, lakeNativeWorkflowLinkSchema, type LakeNativeWorkflowLink, type LakeWorkspaceBinding } from '@zcode/shared';
import { LakeDatabase } from '../storage/database.js';
import { CatalogRepository } from '../storage/catalog.js';
import { object } from '../../domain/validation.js';

const WORKSPACE_KIND = 'lake_native_workspace';
const WORKFLOW_KIND = 'lake_native_workflow';
/** Reserved metadata rows contain associations only; native workflow storage remains authoritative. */
export class NativeLakeAssociations {
  private readonly catalog: CatalogRepository;
  constructor(private readonly db: LakeDatabase) { this.catalog = new CatalogRepository(db); }
  list(): { bindings: LakeWorkspaceBinding[]; workflowLinks: LakeNativeWorkflowLink[] } {
    const read = (kind: string) => this.db.all(`SELECT manifest_json FROM ${kind} ORDER BY workspace_path,name`).map(row => object(JSON.parse(String(row.manifest_json))));
    return { bindings: read(WORKSPACE_KIND).map(row => lakeWorkspaceBindingSchema.parse(row)), workflowLinks: read(WORKFLOW_KIND).map(row => lakeNativeWorkflowLinkSchema.parse(row)) };
  }
  forWorkspace(workspacePath: string, workspaceIdentity?: string): LakeWorkspaceBinding | undefined {
    const path = realpathSync(resolve(workspacePath));
    return this.list().bindings.find(binding => (binding.workspaceIdentity ?? binding.workspacePath) === (workspaceIdentity || path));
  }
  async bind(lakeID: string, workspacePath: string, workspaceIdentity?: string): Promise<LakeWorkspaceBinding> {
    if (!isAbsolute(workspacePath)) throw new Error('工作空间路径必须是绝对路径');
    const path = await realpath(workspacePath);
    if (!(await stat(path)).isDirectory()) throw new Error('工作空间不是目录');
    const lake = this.catalog.lake(lakeID);
    const binding = { lakeID: String(lake.id), lakeName: String(lake.name), workspacePath: path, ...(workspaceIdentity ? { workspaceIdentity } : {}) };
    // A workspace belongs to one lake. Remove stale per-workflow associations on reassignment.
    const previous = this.forWorkspace(path, workspaceIdentity);
    this.db.transaction(() => {
      if (previous && previous.lakeID !== binding.lakeID) this.db.run('DELETE FROM lake_native_workflow WHERE workspace_path=?', workspaceIdentity || path);
      this.write(WORKSPACE_KIND, createHash('sha256').update(workspaceIdentity || path).digest('hex'), workspaceIdentity || path, binding);
    });
    return binding;
  }
  workflow(lakeID: string, workspacePath: string, name: string, scope: 'project' | 'global', workspaceIdentity?: string): LakeNativeWorkflowLink {
    const binding = this.forWorkspace(workspacePath, workspaceIdentity);
    if (!binding || binding.lakeID !== lakeID) throw new Error('工作流工作空间不属于所选湖，请先显式关联');
    const link = { ...binding, name, scope };
    this.write(WORKFLOW_KIND, `${scope}:${name}`, binding.workspaceIdentity || binding.workspacePath, link);
    return link;
  }
  private write(kind: string, name: string, workspace: string, value: LakeWorkspaceBinding | LakeNativeWorkflowLink): void {
    this.db.transaction(() => {
      const now = Date.now();
      this.db.run(`INSERT INTO ${kind}(name,workspace_path,lake_id,manifest_json,created_at,updated_at)
        VALUES(?,?,?,?,?,?) ON CONFLICT(name,workspace_path) DO UPDATE SET lake_id=excluded.lake_id,manifest_json=excluded.manifest_json,updated_at=excluded.updated_at`, name, workspace, value.lakeID, JSON.stringify(value), now, now);
      this.db.run("INSERT INTO journal(ts,action_id,actor,target_path,tool,risk,event,detail) VALUES(?,?,'cli',?,'lake.native.association','write','completed',?)", now, randomUUID(), String(value.lakeID), JSON.stringify({ kind, name }));
    });
  }
}
