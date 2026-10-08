import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createLakeApplication } from "../../src/app/application.js";
export async function testApplication(
  baseUrl = "http://127.0.0.1:1/v1",
  background = true,
) {
  const home = await mkdtemp(join(tmpdir(), "lake-app-test-"));
  const app = await createLakeApplication({
    home,
    background,
    config: {
      schemaVersion: 1,
      defaultProvider: "fixture",
      providers: [
        {
          id: "fixture",
          baseUrl,
          model: "fixture",
          contextWindowTokens: 65536,
          maxOutputTokens: 1024,
          supportsTools: true,
        },
      ],
    },
  });
  const lakeId = randomUUID(),
    environmentId = randomUUID();
  await app.importResources({
    lakes: [{ id: lakeId, name: "Test", description: "Synthetic fixtures" }],
    environments: [
      { id: environmentId, lakeId, name: "Test", classification: "test" },
    ],
    resources: [],
  });
  return {
    app,
    home,
    lakeId,
    environmentId,
    async close() {
      await app.stop();
      await rm(home, { recursive: true, force: true });
    },
  };
}
