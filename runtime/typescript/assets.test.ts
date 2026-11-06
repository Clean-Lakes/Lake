import { test } from "node:test";
import assert from "node:assert/strict";
import type { Resource } from "../../web-agent/shared/contracts";
import { assetPageBytes, listProjectAssets } from "./assets";
import { digest } from "./tasks";

function catalog(count = 140): Resource[] {
  return Array.from({ length: count }, (_, index) => ({ id: `resource-${String(index).padStart(3, "0")}`, projectId: "project",
    name: index === count - 1 ? "京东云服务器" : `服务器 ${index}`, kind: "ssh", status: "available", description: "not part of the model catalog",
    ssh: { host: "private-host.invalid", port: 22, username: "private-user", credentialRef: "private-credential-reference" },
    settings: { password: "synthetic-private-password" } }));
}
const source = (resources: Resource[]) => ({ projectId: "project", resources, sshRevision: (resource: Resource) => digest([resource.id, "current-configuration"]) });

test("a target beyond the first 136 resources is directly discoverable by exact ID and Chinese name", () => {
  const resources = catalog();
  const first = listProjectAssets(source(resources));
  assert.equal(first.assets.length, 20); assert.equal(first.hasMore, true); assert.equal(first.total, 140);
  assert.ok(!first.assets.some((resource) => resource.name === "京东云服务器"));
  let inspected: string[] = [];
  const input = { ...source(resources), sshRevision: (resource: Resource) => { inspected.push(resource.id); return digest(resource.id); } };
  const exact = listProjectAssets(input, { asset_ref: "resource-139" });
  assert.deepEqual(exact.assets.map((resource) => resource.id), ["resource-139"]);
  assert.equal(exact.assets[0].configuration_revision, digest("resource-139"));
  assert.deepEqual(inspected, ["resource-139"]);
  inspected = [];
  const named = listProjectAssets(input, { query: "京东云服务器" });
  assert.deepEqual(named.assets.map((resource) => resource.id), ["resource-139"]);
  assert.equal(named.hasMore, false); assert.equal(named.nextCursor, undefined);
  assert.deepEqual(inspected, ["resource-139"]);
});

test("same-name matches remain distinct and callers can resolve their exact identity", () => {
  const resources = catalog(3); resources[0].name = resources[2].name = "生产服务器";
  const result = listProjectAssets(source(resources), { query: "生产服务器" });
  assert.equal(result.total, 2); assert.deepEqual(result.assets.map((resource) => resource.asset_ref), ["resource-000", "resource-002"]);
  assert.deepEqual(listProjectAssets(source(resources), { asset_ref: "resource-002" }).assets.map((resource) => resource.id), ["resource-002"]);
});

test("all resources are reachable exactly once through stable pages regardless of source insertion order", () => {
  const resources = catalog(173).reverse(); const seen: string[] = [];
  let cursor: string | undefined, pages = 0;
  do {
    const page = listProjectAssets(source(resources), { cursor, limit: 17 });
    assert.equal(page.total, 173); assert.ok(page.assets.length <= 17); assert.ok(Buffer.byteLength(JSON.stringify(page)) <= assetPageBytes);
    seen.push(...page.assets.map((resource) => resource.id)); cursor = page.nextCursor;
    assert.equal(page.hasMore, !!cursor); assert.ok(++pages < 20);
  } while (cursor);
  assert.equal(seen.length, 173); assert.equal(new Set(seen).size, 173);
  assert.deepEqual(seen, resources.map((resource) => resource.id).sort());
});

test("large escaped Chinese names shrink page size without losing IDs or breaking JSON", () => {
  const resources = catalog(136).map((resource) => ({ ...resource, name: '名"称\\'.repeat(300) + resource.id }));
  let cursor: string | undefined; const seen: string[] = [];
  do {
    const page = listProjectAssets(source(resources), { cursor, limit: 50 });
    assert.ok(page.assets.length > 0); assert.ok(page.assets.length < 50);
    assert.ok(page.assets.every((resource) => resource.nameTruncated === true && !resource.name.includes("�")));
    assert.ok(Buffer.byteLength(JSON.stringify(page)) <= assetPageBytes);
    assert.deepEqual(JSON.parse(JSON.stringify(page)), page);
    seen.push(...page.assets.map((resource) => resource.id)); cursor = page.nextCursor;
  } while (cursor);
  assert.equal(new Set(seen).size, 136);
  assert.equal(listProjectAssets(source(resources), { asset_ref: "resource-135" }).assets[0].id, "resource-135");
});

test("project scope applies to exact ID, search, cursor and connection-version callbacks", () => {
  const resources = catalog(3); resources[2].projectId = "foreign"; resources[2].name = "foreign-only";
  const accessed: string[] = [];
  const input = { ...source(resources), resourceRevision: (resource: Resource) => { accessed.push(resource.id); return 1; },
    sshRevision: (resource: Resource) => { assert.equal(resource.projectId, "project"); return digest(resource.id); } };
  assert.deepEqual(listProjectAssets(input, { asset_ref: "resource-002" }).assets, []);
  assert.deepEqual(listProjectAssets(input, { query: "foreign-only" }).assets, []);
  const first = listProjectAssets(input, { limit: 1 });
  assert.throws(() => listProjectAssets({ ...input, projectId: "foreign" }, { limit: 1, cursor: first.nextCursor }), /different project or query/);
  assert.ok(!accessed.slice(0, 6).includes("resource-002"));
});

test("malformed, query-mismatched and nonexistent cursor positions are rejected", () => {
  const input = source(catalog()); const first = listProjectAssets(input, { query: "服务器", limit: 1 });
  for (const cursor of ["!bad", "e30", Buffer.from(JSON.stringify({ version: 99 })).toString("base64url")])
    assert.throws(() => listProjectAssets(input, { cursor }), /Invalid asset cursor/);
  assert.throws(() => listProjectAssets(input, { query: "京东云", cursor: first.nextCursor }), /different project or query/);
  const forged = JSON.parse(Buffer.from(first.nextCursor!, "base64url").toString("utf8")); forged.after = "not-in-catalog";
  assert.throws(() => listProjectAssets(input, { query: "服务器", cursor: Buffer.from(JSON.stringify(forged)).toString("base64url") }), /position/);
});

test("catalog changes invalidate a cursor while the exact current target remains retrievable", () => {
  const resources = catalog(); let revision = 1;
  const input = { ...source(resources), resourceRevision: () => revision };
  const page = listProjectAssets(input, { limit: 1 }); revision++;
  assert.throws(() => listProjectAssets(input, { cursor: page.nextCursor }), /catalog changed/);
  assert.equal(listProjectAssets(input, { asset_ref: "resource-139" }).assets[0].name, "京东云服务器");
});

test("MySQL catalog supplies exact configuration pins without credentials or a connectivity claim", () => {
  const resource:Resource={...catalog(1)[0],kind:'database',settings:{driver:'mysql',database:'app',host:'private-host',username:'private-user',credentialRef:'private-ref'}};
  const page=listProjectAssets({...source([resource]),databaseRevision:current=>{assert.equal(current.id,resource.id);return digest('current-configuration');}});
  assert.equal(page.assets[0].driver,'mysql');assert.equal(page.assets[0].database,'app');assert.equal(page.assets[0].configuration_revision,digest('current-configuration'));
  assert.match(page.assets[0].connectionState!,/not a connectivity/);
  assert.doesNotMatch(JSON.stringify(page),/private-host|private-user|private-ref/);
  const invalid=listProjectAssets({...source([resource]),databaseRevision:()=>{throw new Error('private-error');}});
  assert.equal(invalid.assets[0].configuration_state,'unavailable');assert.doesNotMatch(JSON.stringify(invalid),/private-error/);
});

test("one broken connection does not hide later resources or disclose configuration or credential details", () => {
  const resources = catalog(3);
  const input = { ...source(resources), sshRevision: (resource: Resource) => {
    if (resource.id === "resource-000") throw new Error("private-credential-reference synthetic-private-password /private/secrets/key");
    return digest(resource.id);
  } };
  const first = listProjectAssets(input, { limit: 1 });
  assert.equal(first.assets[0].configuration_state, "unavailable"); assert.equal(first.assets[0].configuration_revision, undefined);
  const next = listProjectAssets(input, { limit: 1, cursor: first.nextCursor });
  assert.equal(next.assets[0].configuration_revision, digest("resource-001"));
  const output = JSON.stringify([first, next]);
  for (const privateValue of ["private-host.invalid", "private-user", "private-credential-reference", "synthetic-private-password", "/private/secrets/key", "not part of the model catalog"])
    assert.ok(!output.includes(privateValue));
});

test("configuration versions are current, never synthesized and absent for unavailable adapters", () => {
  const resources = catalog(1); let revision = digest("first");
  const input = { ...source(resources), sshRevision: () => revision };
  assert.equal(listProjectAssets(input).assets[0].configuration_revision, revision);
  revision = digest("second"); assert.equal(listProjectAssets(input).assets[0].configuration_revision, revision);
  assert.equal(listProjectAssets({ projectId: "project", resources }).assets[0].configuration_revision, undefined);
  assert.equal(listProjectAssets({ ...input, sshRevision: () => "not-a-revision" }).assets[0].configuration_state, "unavailable");
});

test("inputs are bounded and empty or conflicting searches are not silently broadened", () => {
  const input = source(catalog());
  for (const limit of [0, 51, 1.5, NaN]) assert.throws(() => listProjectAssets(input, { limit }), /limit/);
  for (const query of ["", " ", "x".repeat(1025), "null\0byte"]) assert.throws(() => listProjectAssets(input, { query }), /query/);
  assert.throws(() => listProjectAssets(input, { asset_ref: "resource-139", query: "服务器" }), /not both/);
  assert.equal(listProjectAssets(input, { query: "RESOURCE-139" }).assets[0].id, "resource-139");
  assert.deepEqual(listProjectAssets(input, { query: "没有这个资源" }).assets, []);
});
