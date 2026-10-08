import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ResourceSchema, publicProjection } from "../../src/domain/schemas.js";
import { ConfigSchema } from "../../src/domain/config.js";
test("public resource contracts validate identities and exclude private fields", () => {
  const resource = {
    id: randomUUID(),
    lakeId: randomUUID(),
    environmentId: randomUUID(),
    kind: "ssh",
    name: "Fixture",
    endpoint: "ssh://127.0.0.1:22",
    identity: "fixture-host",
    credentialRef: "ssh/fixture",
  };
  const parsed = ResourceSchema.parse(resource);
  assert.equal(parsed.revision, 1);
  assert(!JSON.stringify(publicProjection(parsed)).includes("credentialRef"));
  assert(!ResourceSchema.safeParse({ ...resource, kind: "shell" }).success);
  assert(!ResourceSchema.safeParse({ ...resource, unsafe: true }).success);
  assert(!ResourceSchema.safeParse({ ...resource, id: "127.0.0.1" }).success);
});
test("model capability windows and provider references are required", () => {
  assert(
    !ConfigSchema.safeParse({
      schemaVersion: 1,
      defaultProvider: "none",
      providers: [],
    }).success,
  );
  const config = ConfigSchema.parse({
    schemaVersion: 1,
    defaultProvider: "fixture",
    providers: [
      {
        id: "fixture",
        baseUrl: "http://127.0.0.1:1/v1",
        model: "fixture",
        contextWindowTokens: 32768,
        maxOutputTokens: 4096,
        supportsTools: true,
      },
    ],
    limits: {},
  });
  assert.equal(config.limits.maxActiveSpecialists, 3);
  assert.equal(config.limits.maxActiveModelRequests, 2);
});
