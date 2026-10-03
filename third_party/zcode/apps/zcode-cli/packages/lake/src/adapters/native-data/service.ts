import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { lakeDataRequestSchema, type LakeDataOverview, type LakeDataResult } from '@zcode/shared';
import { LakeDatabase, privateDirectory } from '../storage/database.js';
import { LakeData } from '../storage/data.js';
import { NativeLakeAssociations } from './associations.js';
import { object, type Params } from '../../domain/validation.js';
import { importLakeNativeModels } from './model-import.js';

/** Data-only entry: no custom Agent, workflow executor or scheduler is constructed. */
export class NativeLakeDataService {
  readonly associations: NativeLakeAssociations;
  readonly data: LakeData;
  private constructor(readonly root: string, private readonly db: LakeDatabase) { this.data = new LakeData(db); this.associations = new NativeLakeAssociations(db); }
  static async open(root = process.env.LAKE_HOME || join(homedir(), '.lake')): Promise<NativeLakeDataService> {
    await importLakeNativeModels(resolve(root));
    return new NativeLakeDataService(resolve(root), await LakeDatabase.open(root));
  }
  async request(input: unknown): Promise<LakeDataResult> {
    const p = lakeDataRequestSchema.parse(input);
    switch (p.action) {
      case 'overview': {
        const lakes = await this.data.request('lake.list', {}) as unknown as LakeDataOverview['lakes'];
        const resources = (await this.data.request('res.list', {}) as Params[]).map(row => this.resource(row));
        return { lakes: lakes.map(({ id, name, description }) => ({ id, name, description })), resources, ...this.associations.list() };
      }
      case 'lake.add': {
        const lake = object(await this.data.request('lake.add', { name: p.name, description: p.description ?? '' }));
        return { id: String(lake.id), name: String(lake.name), description: String(lake.description) };
      }
      case 'workspace.ensure': {
        const lake = object(await this.data.request('lake.get', { lake: p.lakeID }));
        const path = join(this.root, 'native', 'lakes', String(lake.id));
        await privateDirectory(path); return this.associations.bind(p.lakeID, path);
      }
      case 'workspace.bind': return this.associations.bind(p.lakeID, p.workspacePath, p.workspaceIdentity);
      case 'workflow.bind': return this.associations.workflow(p.lakeID, p.workspacePath, p.name, p.scope, p.workspaceIdentity);
      case 'resource.add': return this.resource(object(await this.data.request('res.add', { lake: p.lakeID, name: p.name, spec: { ssh: { host: p.host, port: p.port, username: p.username } } })));
      case 'journal.list': {
        const lake = object(await this.data.request('lake.get', { lake: p.lakeID })), prefix = `${String(lake.name)}/`;
        return this.db.all('SELECT ts,target_path,tool,event,risk FROM journal WHERE target_path=? OR target_path=? OR substr(target_path,1,length(?))=? ORDER BY id DESC LIMIT ?', p.lakeID, String(lake.name), prefix, prefix, p.limit ?? 50)
          .map(({ ts, target_path, tool, event, risk }) => ({ timestamp: new Date(Number(ts)).toISOString(), target_path, tool, event, risk }));
      }
    }
  }
  close(): void { this.data.close(); }
  private resource(row: Params): LakeDataOverview['resources'][number] {
    const ssh = object(row.ssh);
    return { id: String(row.id), lake: String(row.lake), name: String(row.name), kind: String(row.kind), execute_authz: row.execute_authz === true,
      ...(ssh.host ? { ssh: { host: String(ssh.host), port: Number(ssh.port), username: String(ssh.username) } } : {}) };
  }
}
