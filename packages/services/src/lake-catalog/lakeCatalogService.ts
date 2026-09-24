/* eslint-disable max-lines -- 湖、资源与 SSH 共用一个 SQLite 事务所有者；绑定字段迁移与唯一约束保持在同一服务中。 */
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { getAppConfigDir } from "../paths.js";
import type { ICredentialService } from "../credential/credential.js";
import { lakeSshPasswordKey } from "./lakeSshPasswordKey.js";
import type {
  CreateLakeInput,
  CreateLakeResourceInput,
  ILakeCatalogService,
  Lake,
  LakeResource,
  LakeResourceEnvironment,
  LakeResourceKind,
  LakeSshProfile,
  LakeSshProfileInput,
  LakeWorkspaceBinding,
} from "./lakeCatalog.js";

const require = createRequire(import.meta.url);
const { DatabaseSync: SQLiteDatabase } = require("node:sqlite") as typeof import("node:sqlite");

type LakeRow = {
  id: string;
  name: string;
  description: string;
  created_at: number;
  workspace_path: string | null;
  workspace_identity: string | null;
  workspace_key: string | null;
};
type ResourceRow = LakeRow & { kind: string; environment: string };
type SshProfileRow = {
  resource_id: string;
  host: string;
  port: number;
  username: string;
  private_key_path: string | null;
  updated_at: number;
};

const kinds = new Set<LakeResourceKind>(["service", "host", "kubernetes-cluster", "database"]);
const environments = new Set<LakeResourceEnvironment>([
  "production",
  "staging",
  "development",
  "other",
]);

function requiredName(value: string): string {
  const name = value?.trim();
  if (!name || name.length > 100) {
    throw new Error("Name must be between 1 and 100 characters");
  }
  return name;
}

function description(value: string | undefined): string {
  const trimmed = value?.trim() ?? "";
  if (trimmed.length > 1000) {
    throw new Error("Description must be at most 1000 characters");
  }
  return trimmed;
}

function toLake(row: LakeRow): Lake {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    createdAt: row.created_at,
    ...(row.workspace_path ? { workspacePath: row.workspace_path } : {}),
    ...(row.workspace_identity ? { workspaceIdentity: row.workspace_identity } : {}),
  };
}

function normalizeWorkspaceBinding(input: LakeWorkspaceBinding): {
  workspacePath: string;
  workspaceIdentity: string | null;
  workspaceKey: string;
} {
  const workspacePath = input.workspacePath?.trim();
  if (!workspacePath) throw new Error("Workspace path is required");
  const workspaceIdentity = input.workspaceIdentity?.trim() || null;
  return { workspacePath, workspaceIdentity, workspaceKey: workspaceIdentity || workspacePath };
}

function toResource(row: ResourceRow): LakeResource {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind as LakeResourceKind,
    environment: row.environment as LakeResourceEnvironment,
    description: row.description,
    createdAt: row.created_at,
  };
}

function toSshProfile(row: SshProfileRow): LakeSshProfile {
  return {
    resourceId: row.resource_id,
    host: row.host,
    port: row.port,
    username: row.username,
    ...(row.private_key_path ? { privateKeyPath: row.private_key_path } : {}),
    updatedAt: row.updated_at,
  };
}

function validateSshProfile(input: LakeSshProfileInput): LakeSshProfileInput {
  const host = input.host.trim();
  const username = input.username.trim();
  const privateKeyPath = input.privateKeyPath?.trim() || undefined;
  // 主机名作为 ssh argv 的最后一个参数；拒绝选项前缀和控制字符，避免其被解释成额外选项。
  if (!host || host.length > 255 || !/^[a-zA-Z0-9_][a-zA-Z0-9_.:%-]*$/u.test(host)) {
    throw new Error("Invalid SSH host");
  }
  if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535) {
    throw new Error("Invalid SSH port");
  }
  if (!username || username.length > 64 || !/^[a-zA-Z_][a-zA-Z0-9_.-]*$/u.test(username)) {
    throw new Error("Invalid SSH username");
  }
  if (
    privateKeyPath &&
    (privateKeyPath.length > 1024 ||
      ["\u0000", "\r", "\n"].some((character) => privateKeyPath.includes(character)))
  ) {
    throw new Error("Invalid SSH private key path");
  }
  return { host, port: input.port, username, ...(privateKeyPath ? { privateKeyPath } : {}) };
}

export function createLakeCatalogService(
  options: { databasePath?: string; credentialService?: ICredentialService } = {},
): ILakeCatalogService & {
  close(): void;
} {
  const databasePath = options.databasePath ?? join(getAppConfigDir(), "lake-catalog.sqlite");
  let databasePromise: Promise<DatabaseSync> | null = null;
  let database: DatabaseSync | null = null;
  let closed = false;

  const getDatabase = (): Promise<DatabaseSync> => {
    if (closed) return Promise.reject(new Error("Lake catalog service is closed"));
    databasePromise ??= (async () => {
      await mkdir(dirname(databasePath), { recursive: true });
      if (closed) throw new Error("Lake catalog service is closed");
      const db = new SQLiteDatabase(databasePath);
      db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
      db.exec(`
        CREATE TABLE IF NOT EXISTS lakes (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          name_key TEXT NOT NULL UNIQUE,
          description TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS resources (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          kind TEXT NOT NULL,
          environment TEXT NOT NULL,
          description TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS lake_resources (
          lake_id TEXT NOT NULL REFERENCES lakes(id),
          resource_id TEXT NOT NULL REFERENCES resources(id),
          added_at INTEGER NOT NULL,
          PRIMARY KEY (lake_id, resource_id)
        );
        CREATE TABLE IF NOT EXISTS ssh_profiles (
          resource_id TEXT PRIMARY KEY REFERENCES resources(id) ON DELETE CASCADE,
          host TEXT NOT NULL,
          port INTEGER NOT NULL,
          username TEXT NOT NULL,
          private_key_path TEXT,
          updated_at INTEGER NOT NULL
        );
      `);
      // 旧目录中的湖没有工作区绑定；只加可空列，避免猜测历史会话应归属哪个湖。
      const lakeColumns = new Set(
        (db.prepare("PRAGMA table_info(lakes)").all() as Array<{ name: string }>).map(
          (column) => column.name,
        ),
      );
      if (!lakeColumns.has("workspace_path"))
        db.exec("ALTER TABLE lakes ADD COLUMN workspace_path TEXT");
      if (!lakeColumns.has("workspace_identity"))
        db.exec("ALTER TABLE lakes ADD COLUMN workspace_identity TEXT");
      if (!lakeColumns.has("workspace_key"))
        db.exec("ALTER TABLE lakes ADD COLUMN workspace_key TEXT");
      db.exec(
        "CREATE UNIQUE INDEX IF NOT EXISTS lakes_workspace_key_unique ON lakes(workspace_key)",
      );
      database = db;
      return db;
    })().catch((error: unknown) => {
      databasePromise = null;
      throw error;
    });
    return databasePromise;
  };

  const lakeExists = (db: DatabaseSync, lakeId: string): boolean =>
    Boolean(db.prepare("SELECT 1 FROM lakes WHERE id = ?").get(lakeId));
  const resourceById = (db: DatabaseSync, resourceId: string): LakeResource | null => {
    const row = db.prepare("SELECT * FROM resources WHERE id = ?").get(resourceId) as
      | ResourceRow
      | undefined;
    return row ? toResource(row) : null;
  };
  const assertHostResource = (db: DatabaseSync, resourceId: string): void => {
    if (resourceById(db, resourceId)?.kind !== "host") {
      throw new Error("SSH profile requires a host resource");
    }
  };
  const requireCredentials = (): ICredentialService => {
    if (!options.credentialService) throw new Error("SSH credential storage is unavailable");
    return options.credentialService;
  };

  return {
    async listLakes() {
      const db = await getDatabase();
      return (db.prepare("SELECT * FROM lakes ORDER BY created_at, name").all() as LakeRow[]).map(
        toLake,
      );
    },
    async createLake(input: CreateLakeInput) {
      const name = requiredName(input.name);
      const nameKey = name.toLowerCase();
      const binding = input.workspacePath
        ? normalizeWorkspaceBinding({
            workspacePath: input.workspacePath,
            workspaceIdentity: input.workspaceIdentity,
          })
        : null;
      const lake: Lake = {
        id: randomUUID(),
        name,
        description: description(input.description),
        createdAt: Date.now(),
        ...(binding ? { workspacePath: binding.workspacePath } : {}),
        ...(binding?.workspaceIdentity ? { workspaceIdentity: binding.workspaceIdentity } : {}),
      };
      const db = await getDatabase();
      try {
        db.prepare(
          "INSERT INTO lakes (id, name, name_key, description, created_at, workspace_path, workspace_identity, workspace_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        ).run(
          lake.id,
          lake.name,
          nameKey,
          lake.description,
          lake.createdAt,
          binding?.workspacePath ?? null,
          binding?.workspaceIdentity ?? null,
          binding?.workspaceKey ?? null,
        );
      } catch (error) {
        if (String(error).includes("UNIQUE constraint failed")) {
          throw new Error(
            String(error).includes("workspace_key")
              ? "Workspace already bound to a lake"
              : "Lake already exists",
          );
        }
        throw error;
      }
      return lake;
    },
    async bindLakeWorkspace(lakeId: string, input: LakeWorkspaceBinding) {
      const binding = normalizeWorkspaceBinding(input);
      const db = await getDatabase();
      try {
        const result = db
          .prepare(
            "UPDATE lakes SET workspace_path = ?, workspace_identity = ?, workspace_key = ? WHERE id = ?",
          )
          .run(binding.workspacePath, binding.workspaceIdentity, binding.workspaceKey, lakeId);
        if (result.changes === 0) throw new Error("Lake not found");
      } catch (error) {
        if (String(error).includes("UNIQUE constraint failed")) {
          throw new Error("Workspace already bound to a lake");
        }
        throw error;
      }
      return toLake(db.prepare("SELECT * FROM lakes WHERE id = ?").get(lakeId) as LakeRow);
    },
    async getLakeForWorkspace(workspacePath: string, workspaceIdentity?: string) {
      const binding = normalizeWorkspaceBinding({ workspacePath, workspaceIdentity });
      const db = await getDatabase();
      const row = db
        .prepare("SELECT * FROM lakes WHERE workspace_key = ?")
        .get(binding.workspaceKey) as LakeRow | undefined;
      return row ? toLake(row) : null;
    },
    async listResources() {
      const db = await getDatabase();
      return (db.prepare("SELECT * FROM resources ORDER BY name, id").all() as ResourceRow[]).map(
        toResource,
      );
    },
    async listLakeResources(lakeId: string) {
      const db = await getDatabase();
      if (!lakeExists(db, lakeId)) throw new Error("Lake not found");
      return (
        db
          .prepare(
            "SELECT resources.* FROM resources JOIN lake_resources ON resources.id = lake_resources.resource_id WHERE lake_resources.lake_id = ? ORDER BY resources.name, resources.id",
          )
          .all(lakeId) as ResourceRow[]
      ).map(toResource);
    },
    async createResourceInLake(lakeId: string, input: CreateLakeResourceInput) {
      const name = requiredName(input.name);
      const details = description(input.description);
      if (!kinds.has(input.kind)) throw new Error("Invalid resource kind");
      if (!environments.has(input.environment)) throw new Error("Invalid environment");
      const db = await getDatabase();
      const resource: LakeResource = {
        id: randomUUID(),
        name,
        kind: input.kind,
        environment: input.environment,
        description: details,
        createdAt: Date.now(),
      };
      db.exec("BEGIN IMMEDIATE");
      try {
        if (!lakeExists(db, lakeId)) throw new Error("Lake not found");
        db.prepare(
          "INSERT INTO resources (id, name, kind, environment, description, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        ).run(
          resource.id,
          resource.name,
          resource.kind,
          resource.environment,
          resource.description,
          resource.createdAt,
        );
        db.prepare(
          "INSERT INTO lake_resources (lake_id, resource_id, added_at) VALUES (?, ?, ?)",
        ).run(lakeId, resource.id, Date.now());
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      return resource;
    },
    async addResourceToLake(lakeId: string, resourceId: string) {
      const db = await getDatabase();
      const resource = resourceById(db, resourceId);
      if (!resource) throw new Error("Resource not found");
      if (!lakeExists(db, lakeId)) throw new Error("Lake not found");
      db.prepare(
        "INSERT OR IGNORE INTO lake_resources (lake_id, resource_id, added_at) VALUES (?, ?, ?)",
      ).run(lakeId, resourceId, Date.now());
      return resource;
    },
    async getSshProfile(resourceId: string) {
      const db = await getDatabase();
      const row = db.prepare("SELECT * FROM ssh_profiles WHERE resource_id = ?").get(resourceId) as
        | SshProfileRow
        | undefined;
      return row ? toSshProfile(row) : null;
    },
    async saveSshProfile(resourceId: string, input: LakeSshProfileInput) {
      const normalized = validateSshProfile(input);
      const db = await getDatabase();
      assertHostResource(db, resourceId);
      const profile: LakeSshProfile = {
        resourceId,
        ...normalized,
        updatedAt: Date.now(),
      };
      db.prepare(
        `INSERT INTO ssh_profiles (resource_id, host, port, username, private_key_path, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(resource_id) DO UPDATE SET
           host = excluded.host,
           port = excluded.port,
           username = excluded.username,
           private_key_path = excluded.private_key_path,
           updated_at = excluded.updated_at`,
      ).run(
        profile.resourceId,
        profile.host,
        profile.port,
        profile.username,
        profile.privateKeyPath ?? null,
        profile.updatedAt,
      );
      return profile;
    },
    async hasSshPassword(resourceId: string) {
      const db = await getDatabase();
      assertHostResource(db, resourceId);
      if (!options.credentialService) return false;
      return (await options.credentialService.load(lakeSshPasswordKey(resourceId))) !== null;
    },
    async saveSshPassword(resourceId: string, password: string) {
      if (!password || password.length > 4096) throw new Error("Invalid SSH password");
      const db = await getDatabase();
      assertHostResource(db, resourceId);
      await requireCredentials().save(lakeSshPasswordKey(resourceId), password);
    },
    async deleteSshPassword(resourceId: string) {
      const db = await getDatabase();
      assertHostResource(db, resourceId);
      await requireCredentials().delete(lakeSshPasswordKey(resourceId));
    },
    close() {
      closed = true;
      database?.close();
      database = null;
    },
  };
}
