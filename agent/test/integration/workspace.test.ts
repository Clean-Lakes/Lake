import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, symlink, readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { testHome } from "../fixtures/home.js";
import { ContainerSandbox } from "../../src/adapters/sandbox.js";
import { WorkspaceAdapter, sha256 } from "../../src/adapters/workspace.js";
import type { Resource } from "../../src/domain/entities.js";
test("workspace changes require the old hash and cannot escape to private paths", async (t) => {
  const h = await testHome();
  t.after(() => h.close());
  const project = join(h.root, "project");
  await mkdir(project);
  await writeFile(join(project, "app.ts"), "old");
  await writeFile(join(project, ".env"), "private");
  await symlink(join(project, ".env"), join(project, "link"));
  const resource: Resource = {
    id: randomUUID(),
    revision: 1,
    lakeId: h.lakeId,
    environmentId: h.environmentId,
    kind: "local",
    name: "Fixture",
    endpoint: project,
    identity: project,
    settings: {},
  };
  const adapter = new WorkspaceAdapter(h.artifacts, join(h.root, "secrets"));
  await assert.rejects(adapter.read(resource, ".env"));
  await assert.rejects(adapter.read(resource, "link"));
  await assert.rejects(adapter.read(resource, "../secrets"));
  const id = await adapter.proposePatch(
    resource,
    "app.ts",
    sha256("old"),
    "new",
    undefined as any,
  );
  await adapter.applyPatch(resource, "app.ts", sha256("old"), id);
  assert.equal(await readFile(join(project, "app.ts"), "utf8"), "new");
  await assert.rejects(
    adapter.applyPatch(resource, "app.ts", sha256("old"), id),
  );
});

test("real container workspace omits credentials, rejects links, disables network and is read-only", async (t) => {
  const h = await testHome();
  t.after(() => h.close());
  const project = join(h.root, "project");
  await mkdir(project);
  await writeFile(join(project, "app.txt"), "safe source");
  await writeFile(join(project, ".env"), "synthetic-private-value");
  await mkdir(join(project, "secrets"));
  await writeFile(
    join(project, "secrets", "credential"),
    "synthetic-private-value",
  );
  await symlink(join(project, ".env"), join(project, "alias"));
  const resource: Resource = {
    id: randomUUID(),
    revision: 1,
    lakeId: h.lakeId,
    environmentId: h.environmentId,
    kind: "local",
    name: "Container fixture",
    endpoint: project,
    identity: project,
    settings: {
      testProfile: {
        image: "node:24.14.0-bookworm",
        argv: [
          "node",
          "-e",
          "const f=require('fs');if(f.existsSync('.env')||f.existsSync('secrets')||f.existsSync('alias'))process.exit(2);try{f.writeFileSync('app.txt','bad');process.exit(3)}catch{}if(f.readFileSync('app.txt','utf8')!=='safe source')process.exit(4);require('http').get('http://192.0.2.1',{timeout:500},()=>process.exit(5)).on('error',()=>process.stdout.write('isolated-ok')).on('timeout',function(){this.destroy()});",
        ],
      },
    },
  };
  const sandbox = new ContainerSandbox(join(h.root, "secrets")),
    result = (await sandbox.runTest(
      resource,
      new AbortController().signal,
    )) as any;
  assert.equal(result.exitCode, 0);
  assert(result.stdout.includes("isolated-ok"));
  await assert.rejects(
    sandbox.runTest(
      { ...resource, settings: {} },
      new AbortController().signal,
    ),
  );
  assert.equal(await readFile(join(project, "app.txt"), "utf8"), "safe source");
});
