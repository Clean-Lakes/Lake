import { z } from 'zod';

const id = z.string().min(1).max(256);
const workspace = { workspacePath: z.string().min(1).max(4096), workspaceIdentity: z.string().max(4096).optional() };
export const lakeDataRequestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('overview') }).strict(),
  z.object({ action: z.literal('lake.add'), name: z.string().trim().min(1).max(128), description: z.string().max(2000).optional() }).strict(),
  z.object({ action: z.literal('workspace.ensure'), lakeID: id }).strict(),
  z.object({ action: z.literal('workspace.bind'), lakeID: id, ...workspace }).strict(),
  z.object({ action: z.literal('workflow.bind'), lakeID: id, ...workspace, name: z.string().min(1).max(128), scope: z.enum(['project', 'global']) }).strict(),
  z.object({ action: z.literal('resource.add'), lakeID: id, name: z.string().trim().min(1).max(128), host: z.string().min(1).max(255), port: z.number().int().min(1).max(65535), username: z.string().min(1).max(128) }).strict(),
  z.object({ action: z.literal('journal.list'), lakeID: id, limit: z.number().int().min(1).max(100).optional() }).strict(),
]);
export type LakeDataRequest = z.infer<typeof lakeDataRequestSchema>;
export interface LakeDataLake { id: string; name: string; description: string }
export const lakeWorkspaceBindingSchema = z.object({ lakeID: id, lakeName: z.string().min(1).max(128), ...workspace }).strict();
export type LakeWorkspaceBinding = z.infer<typeof lakeWorkspaceBindingSchema>;
export const lakeNativeWorkflowLinkSchema = lakeWorkspaceBindingSchema.extend({ name: z.string().min(1).max(128), scope: z.enum(['project', 'global']) }).strict();
export interface LakeNativeWorkflowLink extends LakeWorkspaceBinding { name: string; scope: 'project' | 'global' }
export interface LakeDataResource {
  id: string; lake: string; name: string; kind: string; execute_authz: boolean;
  ssh?: { host: string; port: number; username: string };
}
export interface LakeDataOverview {
  lakes: LakeDataLake[]; resources: LakeDataResource[];
  bindings: LakeWorkspaceBinding[]; workflowLinks: LakeNativeWorkflowLink[];
}
export type LakeDataResult = LakeDataOverview | LakeWorkspaceBinding | LakeNativeWorkflowLink | LakeDataLake | LakeDataResource | unknown[];
const lakeSchema = z.object({ id, name: z.string().min(1).max(128), description: z.string().max(2000) }).strict();
const resourceSchema = z.object({ id, lake: z.string().min(1).max(128), name: z.string().min(1).max(128), kind: z.string().max(32), execute_authz: z.boolean(),
  ssh: z.object({ host: z.string().max(255), port: z.number().int().min(1).max(65535), username: z.string().max(128) }).strict().optional() }).strict();
const journalSchema = z.object({ timestamp: z.string().max(64), target_path: z.string().max(4096), tool: z.string().max(256), event: z.string().max(64), risk: z.string().max(32) }).strict();
export type LakeJournalEntry = z.infer<typeof journalSchema>;
export const lakeDataOverviewSchema = z.object({ lakes: z.array(lakeSchema).max(10000), resources: z.array(resourceSchema).max(10000), bindings: z.array(lakeWorkspaceBindingSchema).max(10000), workflowLinks: z.array(lakeNativeWorkflowLinkSchema).max(10000) }).strict();
export const lakeDataResultSchema = z.union([lakeDataOverviewSchema, lakeNativeWorkflowLinkSchema, lakeWorkspaceBindingSchema, lakeSchema, resourceSchema, z.array(journalSchema).max(100)]);
export const LAKE_DATA_IPC_CHANNEL = 'lake:data-request';
