import { test } from "node:test";
import assert from "node:assert/strict";
import type { Resource, ResourceTreeNode } from "../../web-agent/shared/contracts";
import { assetPageBytes, listProjectAssets } from "./assets";
import { digest } from "./tasks";

function catalog(count = 140): Resource[] {
  return Array.from({ length: count }, (_, index) => ({ id: `resource-${String(index).padStart(3, "0")}`, projectId: "project",
    name: index === count - 1 ? "京东云服务器" : `服务器 ${index}`, kind: "ssh", status: "available", description: "not part of the model catalog",
    ssh: { host: "private-host.invalid", port: 22, username: "private-user", credentialRef: "private-credential-reference" },
    settings: { password: "synthetic-private-password" } }));
}
const source = (resources: Resource[]) => ({ projectId: "project", resources, sshRevision: (resource: Resource) => digest([resource.id, "current-configuration"]) });

test('PostgreSQL resources expose their driver without claiming a MySQL execution binding or leaking credentials',()=>{
 const resource:Resource={id:'pg',name:'订单库',projectId:'project',kind:'database',description:'',status:'available',settings:{driver:'postgres',database:'orders',credentialRef:'private-reference'}};
 const result=listProjectAssets(source([resource]));assert.equal(result.assets[0].driver,'postgres');assert.equal(result.assets[0].database,'orders');assert.equal(result.assets[0].configuration_revision,undefined);assert.ok(!JSON.stringify(result).includes('private-reference'));
});

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

const folder = (id: string, name: string, parentId: string | null = null): ResourceTreeNode =>
  ({ id, name, parentId, projectId: "project", kind: "folder", resourceId: null, position: 0 });
const leaf = (resourceId: string, parentId: string | null): ResourceTreeNode =>
  ({ id: `node-${resourceId}`, name: "stale display label", parentId, projectId: "project", kind: "resource", resourceId, position: 0 });

test("Chinese directory queries find IP-named descendants and return the original full Lake path", () => {
  const resources = catalog(141);
  resources[0].name = "192.0.2.50 (Jenkins)";
  resources[139].name = "10.0.0.10"; resources[140].name = "10.0.0.11";
  const resourceTree = [folder("root", "演示组织"), folder("build", "构建环境", "root"), folder("cluster", "实验集群", "root"),
    folder("nodes", "控制节点", "cluster"), leaf(resources[0].id, "build"), leaf(resources[139].id, "nodes"), leaf(resources[140].id, "cluster")];
  const inspected: string[] = [];
  const input = { ...source(resources), resourceTree, sshRevision: (resource: Resource) => { inspected.push(resource.id); return digest(resource.id); } };
  const page = listProjectAssets(input, { query: "实验集群" });
  assert.deepEqual(page.assets.map(asset => asset.asset_ref), ["resource-139", "resource-140"]);
  assert.deepEqual(inspected, ["resource-139", "resource-140"]);
  assert.deepEqual(page.assets.map(asset => asset.path), ["演示组织 / 实验集群 / 控制节点 / 10.0.0.10", "演示组织 / 实验集群 / 10.0.0.11"]);
  for (const query of ["演示组织/实验集群", "演示组织 / 实验集群", "控制节点"])
    assert.ok(listProjectAssets(input, { query }).assets.every(asset => asset.asset_ref !== "resource-000"));
  const exact = listProjectAssets(input, { asset_ref: "resource-000" }).assets[0];
  assert.equal(exact.path, "演示组织 / 构建环境 / 192.0.2.50 (Jenkins)");
  assert.equal(exact.configuration_revision, digest("resource-000"));
});

test("same-name hosts through one gateway remain separate identities in different folders", () => {
  const resources = catalog(2).map((resource, i) => ({ ...resource, name: "应用节点", ssh: { ...resource.ssh!, port: i ? 3370 : 22 } }));
  const input = { ...source(resources), resourceTree: [folder("one", "构建环境"), folder("two", "实验集群"), leaf(resources[0].id, "one"), leaf(resources[1].id, "two")],
    configurationPin: (resource: Resource) => `pin-${resource.id}` };
  const named = listProjectAssets(input, { query: "应用节点" });
  assert.equal(named.total, 2); assert.notEqual(named.assets[0].path, named.assets[1].path);
  const cluster = listProjectAssets(input, { query: "实验集群" });
  assert.equal(cluster.assets[0].asset_ref, resources[1].id); assert.equal(cluster.assets[0].configuration_pin, "pin-resource-001");
  assert.doesNotMatch(JSON.stringify(cluster), /private-host|private-user|credential-reference|synthetic-private-password|"port"/);
});

test("folder rename invalidates a directory query cursor without changing a resource revision", () => {
  const resources = catalog(3), tree = [folder("parent", "旧环境"), ...resources.map(resource => leaf(resource.id, "parent"))];
  const input = { ...source(resources), resourceTree: tree };
  const first = listProjectAssets(input, { query: "旧环境", limit: 1 });
  tree[0] = { ...tree[0], name: "新环境" };
  assert.throws(() => listProjectAssets(input, { query: "旧环境", cursor: first.nextCursor }), /catalog changed/);
  assert.equal(listProjectAssets(input, { query: "新环境" }).total, 3);
  assert.equal(listProjectAssets(input, { asset_ref: resources[0].id }).assets[0].path, "新环境 / 服务器 0");
});

test("moving into a same-name folder invalidates a cursor even when the displayed path is identical", () => {
  const resources = catalog(2), tree = [folder("one", "相同目录"), folder("two", "相同目录"), ...resources.map(resource => leaf(resource.id, "one"))];
  const input = { ...source(resources), resourceTree: tree }, first = listProjectAssets(input, { limit: 1 });
  tree[2] = { ...tree[2], parentId: "two" };
  assert.throws(() => listProjectAssets(input, { cursor: first.nextCursor }), /catalog changed/);
});

test("orphaned, foreign, cyclic and ambiguous ancestry never invent a directory membership", () => {
  const resources = catalog(5), tree = [folder("loop", "循环目录", "loop"), { ...folder("foreign", "foreign-private-folder"), projectId: "foreign" },
    leaf(resources[0].id, "missing"), leaf(resources[1].id, "foreign"), leaf(resources[2].id, "loop"),
    leaf(resources[3].id, null), { ...leaf(resources[3].id, "loop"), id: "duplicate-leaf" }];
  const input = { ...source(resources), resourceTree: tree }, page = listProjectAssets(input);
  for (const resource of page.assets.slice(0, 4)) {
    assert.equal(resource.path, undefined); assert.equal(resource.path_state, "unavailable");
    assert.ok(resource.configuration_revision, "a broken display path cannot remove an otherwise valid exact resource");
  }
  assert.equal(page.assets[4].path, resources[4].name, "legacy resources without tree nodes remain at the root");
  assert.deepEqual(listProjectAssets(input, { query: "循环目录" }).assets, []);
  assert.deepEqual(listProjectAssets(input, { query: "foreign-private-folder" }).assets, []);
  assert.doesNotMatch(JSON.stringify(page), /foreign-private-folder/);
});

test("duplicate ancestors and paths beyond the navigation depth bound are unavailable without hiding other resources", () => {
  const resources = catalog(2);
  const deep = Array.from({ length: 33 }, (_, i) => folder(`deep-${i}`, `层级 ${i}`, i ? `deep-${i - 1}` : null));
  const input = { ...source(resources), resourceTree: [...deep, leaf(resources[0].id, "deep-32"), leaf(resources[1].id, null)] };
  assert.equal(listProjectAssets(input).assets[0].path_state, "unavailable");
  assert.equal(listProjectAssets(input).assets[1].path, resources[1].name);
  const duplicate = { ...input, resourceTree: [folder("same", "一"), folder("same", "二"), leaf(resources[0].id, "same")] };
  assert.equal(listProjectAssets(duplicate).assets[0].path_state, "unavailable");
});

test("long escaped Unicode paths fit each page and search the untruncated ancestry", () => {
  const resources = catalog(47).map(resource => ({ ...resource, name: '节点"\\'.repeat(150) + resource.id }));
  const deep = Array.from({ length: 20 }, (_, i) => folder(`deep-${i}`, i === 19 ? "最深环境" : '环境"\\\n'.repeat(80), i ? `deep-${i - 1}` : null));
  const input = { ...source(resources), resourceTree: [...deep, ...resources.map(resource => leaf(resource.id, "deep-19"))] };
  let cursor: string | undefined; const seen: string[] = [];
  do {
    const page = listProjectAssets(input, { query: "最深环境", cursor, limit: 50 });
    assert.ok(page.assets.length > 0); assert.ok(Buffer.byteLength(JSON.stringify(page)) <= assetPageBytes);
    for (const asset of page.assets) {
      assert.equal(asset.pathTruncated, true); assert.ok(Buffer.byteLength(JSON.stringify(asset.path)) <= 2048);
      assert.ok(!asset.path!.includes("�")); seen.push(asset.asset_ref);
    }
    cursor = page.nextCursor;
  } while (cursor);
  assert.equal(seen.length, 47); assert.equal(new Set(seen).size, 47);
});

test("directory metadata respects the already-filtered task and project scope", () => {
  const resources = catalog(3), foreign = { ...resources[2], id: "foreign-resource", projectId: "foreign" };
  const tree = [folder("allowed", "可见目录"), folder("denied", "sibling-private-folder"),
    { ...folder("outside", "foreign-private-folder"), projectId: "foreign" }, leaf(resources[0].id, "allowed"), leaf(resources[1].id, "allowed"), leaf(resources[2].id, "denied"),
    { ...leaf(foreign.id, "outside"), projectId: "foreign" }];
  const input = { ...source([resources[0], resources[1], foreign]), resourceTree: tree };
  const first = listProjectAssets(input, { limit: 1 });
  assert.equal(first.total, 2); assert.equal(listProjectAssets(input, { query: "sibling-private-folder" }).total, 0);
  assert.equal(listProjectAssets(input, { asset_ref: foreign.id }).total, 0);
  tree[1] = { ...tree[1], name: "renamed-private-folder" };
  assert.equal(listProjectAssets(input, { cursor: first.nextCursor }).assets[0].asset_ref, resources[1].id);
  assert.doesNotMatch(JSON.stringify(listProjectAssets(input)), /private-folder|foreign-resource/);
});
