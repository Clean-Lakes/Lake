import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { prepareHome } from "../../src/app/home.js";
import { SqliteStore } from "../../src/storage/store.js";
import { Redactor } from "../../src/storage/redaction.js";
import { CredentialStore } from "../../src/storage/credentials.js";
import { ArtifactStore } from "../../src/storage/artifacts.js";
export async function testHome() {
  const root = await mkdtemp(join(tmpdir(), "lake-agent-test-"));
  const paths = await prepareHome(root);
  const store = new SqliteStore(paths.database);
  const redactor = new Redactor();
  const credentials = new CredentialStore(join(root, "secrets"), redactor);
  const artifacts = new ArtifactStore(
    join(paths.agent, "artifacts"),
    store,
    redactor,
  );
  const lakeId = randomUUID(),
    environmentId = randomUUID();
  await store.transact([
    {
      op: "put",
      table: "lakes",
      value: {
        id: lakeId,
        revision: 1,
        name: "Test",
        description: "Synthetic fixtures",
      },
      expectedRevision: 0,
    },
    {
      op: "put",
      table: "environments",
      value: {
        id: environmentId,
        revision: 1,
        lakeId,
        name: "Test",
        classification: "test",
      },
      expectedRevision: 0,
    },
  ]);
  return {
    root,
    ...paths,
    store,
    redactor,
    credentials,
    artifacts,
    lakeId,
    environmentId,
    async close() {
      await store.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
