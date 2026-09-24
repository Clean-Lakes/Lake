import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

export type LakeResourceKind = "service" | "host" | "kubernetes-cluster" | "database";
export type LakeResourceEnvironment = "production" | "staging" | "development" | "other";

export interface Lake {
  id: string;
  name: string;
  description: string;
  createdAt: number;
  workspacePath?: string;
  workspaceIdentity?: string;
}

export interface LakeWorkspaceBinding {
  workspacePath: string;
  workspaceIdentity?: string;
}

export interface LakeResource {
  id: string;
  name: string;
  kind: LakeResourceKind;
  environment: LakeResourceEnvironment;
  description: string;
  createdAt: number;
}

export interface CreateLakeInput extends Partial<LakeWorkspaceBinding> {
  name: string;
  description?: string;
}

export interface CreateLakeResourceInput {
  name: string;
  kind: LakeResourceKind;
  environment: LakeResourceEnvironment;
  description?: string;
}

/** 连接元数据不含密码；密码由应用凭据库另行管理。 */
export interface LakeSshProfileInput {
  host: string;
  port: number;
  username: string;
  privateKeyPath?: string;
}

export interface LakeSshProfile extends LakeSshProfileInput {
  resourceId: string;
  updatedAt: number;
}

export interface ILakeCatalogService {
  listLakes(): Promise<Lake[]>;
  createLake(input: CreateLakeInput): Promise<Lake>;
  bindLakeWorkspace(lakeId: string, binding: LakeWorkspaceBinding): Promise<Lake>;
  getLakeForWorkspace(workspacePath: string, workspaceIdentity?: string): Promise<Lake | null>;
  listResources(): Promise<LakeResource[]>;
  listLakeResources(lakeId: string): Promise<LakeResource[]>;
  createResourceInLake(lakeId: string, input: CreateLakeResourceInput): Promise<LakeResource>;
  addResourceToLake(lakeId: string, resourceId: string): Promise<LakeResource>;
  getSshProfile(resourceId: string): Promise<LakeSshProfile | null>;
  saveSshProfile(resourceId: string, input: LakeSshProfileInput): Promise<LakeSshProfile>;
  hasSshPassword(resourceId: string): Promise<boolean>;
  saveSshPassword(resourceId: string, password: string): Promise<void>;
  deleteSshPassword(resourceId: string): Promise<void>;
}

export const ILakeCatalogService = createServiceDescriptor<ILakeCatalogService>(
  ServiceChannels.LakeCatalog,
);
