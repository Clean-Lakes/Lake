import type { Resource, ResourceTreeNode } from "../../web-agent/shared/contracts";
import { HttpError } from "./store";
import { digest } from "./tasks";

export const assetPageBytes = 8192;
export type AssetQuery = { asset_ref?: string; query?: string; cursor?: string; limit?: number };
type AssetSource = {
  projectId: string;
  resources: readonly Resource[];
  resourceTree?: readonly ResourceTreeNode[];
  resourceRevision?: (resource: Resource) => number;
  sshRevision?: (resource: Resource) => string;
  executionRevision?:(resource:Resource)=>string;
  databaseRevision?: (resource:Resource)=>string;
  configurationPin?: (resource:Resource, revision:string)=>string|undefined;
};
type AssetEntry = Pick<Resource, "id" | "name" | "kind" | "status"> & {
  asset_ref: string;
  nameTruncated?: boolean;
  path?: string;
  pathTruncated?: true;
  path_state?: "unavailable";
  configuration_revision?: string;
  configuration_pin?: string;
  configuration_state?: "unavailable";
  connectionState?: string;
  driver?:string;database?:string;
};
type Cursor = { version: 1; scope: string; catalog: string; after: string };

function optionalText(value: unknown, field: string, max: number) {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value) > max || value.includes("\0"))
    throw new HttpError(400, `${field} must be nonempty text (max ${max} bytes)`);
  return value;
}
function clipName(value: string) {
  const bytes = Buffer.from(value); let end = Math.min(bytes.length, 512);
  while (end > 0 && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
  return { name: bytes.subarray(0, end).toString("utf8"), ...(end < bytes.length ? { nameTruncated: true } : {}) };
}
const normalized = (value: string) => value.normalize("NFKC").toLowerCase();
const normalizedPath = (value: string) => normalized(value).replace(/\s*\/\s*/g, "/");

/** Use only the visible resource's own ancestry, never sibling or foreign data. */
function directoryIndex(source: AssetSource) {
  const nodes = new Map<string, ResourceTreeNode>(), duplicates = new Set<string>();
  const leaves = new Map<string, ResourceTreeNode[]>();
  for (const node of source.resourceTree ?? []) {
    if (node.projectId !== source.projectId) continue;
    if (nodes.has(node.id)) duplicates.add(node.id);
    nodes.set(node.id, node);
    if (node.kind === "resource" && node.resourceId)
      leaves.set(node.resourceId, [...(leaves.get(node.resourceId) ?? []), node]);
  }
  return (resource: Resource): { path: string; lineage: string[] } | { unavailable: true } => {
    const candidates = leaves.get(resource.id) ?? [];
    if (candidates.length > 1) return { unavailable: true };
    const leaf = candidates[0];
    if (leaf && duplicates.has(leaf.id)) return { unavailable: true };
    const parts = [resource.name], lineage = leaf ? [leaf.id] : [], seen = new Set(lineage);
    let parentId = leaf?.parentId;
    while (parentId) {
      const parent = nodes.get(parentId);
      if (!parent || parent.kind !== "folder" || typeof parent.name !== "string" || duplicates.has(parentId) || seen.has(parentId) || seen.size >= 32)
        return { unavailable: true };
      seen.add(parentId); lineage.unshift(parentId); parts.unshift(parent.name); parentId = parent.parentId;
    }
    return { path: parts.join(" / "), lineage };
  };
}

/** The JSON budget also bounds quotes/control characters in legacy names. */
function boundedPath(value: string) {
  let path = "", bytes = 2;
  for (const char of value) {
    const length = Buffer.byteLength(JSON.stringify(char)) - 2;
    if (bytes + length > 2048) break;
    path += char; bytes += length;
  }
  return { path, ...(path.length < value.length ? { pathTruncated: true as const } : {}) };
}
const compareIds = (a: Resource, b: Resource) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
const encodeCursor = (value: Cursor) => Buffer.from(JSON.stringify(value)).toString("base64url");
function decodeCursor(value: string): Cursor {
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error();
    const decoded = Buffer.from(value, "base64url");
    if (decoded.toString("base64url") !== value) throw new Error();
    const cursor = JSON.parse(decoded.toString("utf8"));
    if (!cursor || Object.keys(cursor).sort().join(",") !== "after,catalog,scope,version" || cursor.version !== 1 ||
        !/^[a-f0-9]{64}$/.test(cursor.scope) || !/^[a-f0-9]{64}$/.test(cursor.catalog) || typeof cursor.after !== "string" || !cursor.after)
      throw new Error();
    return cursor;
  } catch { throw new HttpError(400, "Invalid asset cursor; restart the query without cursor"); }
}

/** Project metadata only. A cursor and a configuration revision grant no access. */
export function listProjectAssets(source: AssetSource, input: AssetQuery = {}) {
  const assetRef = optionalText(input.asset_ref, "asset_ref", 512);
  const query = optionalText(input.query, "query", 1024)?.trim();
  const cursorText = optionalText(input.cursor, "cursor", 2048);
  const limit = input.limit ?? 20;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new HttpError(400, "Asset page limit must be between 1 and 50");
  if (assetRef && query) throw new HttpError(400, "Use asset_ref for an exact ID or query for a name search, not both");
  const resources = source.resources.filter((resource) => resource.projectId === source.projectId).sort(compareIds);
  const directory = directoryIndex(source), directories = new Map(resources.map(resource => [resource.id, directory(resource)]));
  const catalog = digest(resources.map((resource) => ({ id: resource.id, name: resource.name, kind: resource.kind,
    status: resource.status, revision: source.resourceRevision?.(resource) ?? 1, directory: directories.get(resource.id) })));
  const search = query ? normalized(query) : undefined;
  const scope = digest([source.projectId, assetRef ?? null, search ?? null]);
  const matches = resources.filter((resource) => {
    const current = directories.get(resource.id)!;
    return assetRef ? resource.id === assetRef : !search || normalized(resource.name).includes(search) || normalized(resource.id).includes(search) ||
      ("path" in current && normalizedPath(current.path).includes(normalizedPath(search)));
  });
  let start = 0;
  if (cursorText) {
    const cursor = decodeCursor(cursorText);
    if (cursor.scope !== scope) throw new HttpError(400, "Asset cursor belongs to a different project or query; restart without cursor");
    if (cursor.catalog !== catalog) throw new HttpError(409, "Resource catalog changed; restart the same query without cursor");
    const index = matches.findIndex((resource) => resource.id === cursor.after);
    if (index < 0) throw new HttpError(400, "Asset cursor position is not in this query; restart without cursor");
    start = index + 1;
  }
  const assets: AssetEntry[] = [];
  const page = () => {
    const hasMore = start + assets.length < matches.length;
    return { assets, total: matches.length, hasMore,
      ...(hasMore && assets.length ? { nextCursor: encodeCursor({ version: 1, scope, catalog, after: assets.at(-1)!.id }) } : {}) };
  };
  for (const resource of matches.slice(start, start + limit)) {
    const entry: AssetEntry = { id: resource.id, asset_ref: resource.id, ...clipName(resource.name), kind: resource.kind, status: resource.status };
    const current = directories.get(resource.id)!;
    if ("path" in current) Object.assign(entry, boundedPath(current.path));
    else entry.path_state = "unavailable";
    if (resource.kind === "ssh" && resource.status === "available" && source.sshRevision) {
      try {
        const revision = source.sshRevision(resource);
        if (!/^[a-f0-9]{64}$/.test(revision)) throw new Error("Invalid host configuration revision");
        entry.configuration_revision = revision;
        entry.connectionState = "configured; not a health observation";
      } catch {
        // One malformed legacy connection must not hide the remaining catalog.
        // Never include raw errors: they can contain private credential paths.
        entry.configuration_state = "unavailable";
      }
    }
    if(resource.kind==='local'&&source.executionRevision)entry.configuration_revision=source.executionRevision(resource);
    if(resource.kind==='database'&&['mysql','postgres','sqlite'].includes(String(resource.settings?.driver))){
      entry.driver=String(resource.settings!.driver);if(typeof resource.settings?.database==='string')entry.database=resource.settings.database;
    }
    if(resource.kind==='database'&&resource.settings?.driver==='mysql'){
      entry.driver='mysql';if(typeof resource.settings.database==='string')entry.database=resource.settings.database;
      if(resource.status==='available'&&source.databaseRevision)try{entry.configuration_revision=source.databaseRevision(resource);entry.connectionState='configured; not a connectivity or health observation';}catch{entry.configuration_state='unavailable';}
    }
    if(entry.configuration_revision && source.configurationPin) entry.configuration_pin=source.configurationPin(resource,entry.configuration_revision);
    assets.push(entry);
    if (Buffer.byteLength(JSON.stringify(page())) > assetPageBytes) {
      assets.pop();
      if (!assets.length) throw new HttpError(409, "Resource identity exceeds the asset page budget");
      break;
    }
  }
  return page();
}
