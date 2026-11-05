import type { Resource } from "../../web-agent/shared/contracts";
import { HttpError } from "./store";
import { digest } from "./tasks";

export const assetPageBytes = 8192;
export type AssetQuery = { asset_ref?: string; query?: string; cursor?: string; limit?: number };
type AssetSource = {
  projectId: string;
  resources: readonly Resource[];
  resourceRevision?: (resource: Resource) => number;
  sshRevision?: (resource: Resource) => string;
};
type AssetEntry = Pick<Resource, "id" | "name" | "kind" | "status"> & {
  asset_ref: string;
  nameTruncated?: boolean;
  configuration_revision?: string;
  configuration_state?: "unavailable";
  connectionState?: string;
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
  const catalog = digest(resources.map((resource) => ({ id: resource.id, name: resource.name, kind: resource.kind,
    status: resource.status, revision: source.resourceRevision?.(resource) ?? 1 })));
  const search = query ? normalized(query) : undefined;
  const scope = digest([source.projectId, assetRef ?? null, search ?? null]);
  const matches = resources.filter((resource) => assetRef ? resource.id === assetRef : !search ||
    normalized(resource.name).includes(search) || normalized(resource.id).includes(search));
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
    assets.push(entry);
    if (Buffer.byteLength(JSON.stringify(page())) > assetPageBytes) {
      assets.pop();
      if (!assets.length) throw new HttpError(409, "Resource identity exceeds the asset page budget");
      break;
    }
  }
  return page();
}
