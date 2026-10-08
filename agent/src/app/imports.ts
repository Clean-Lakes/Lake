import { z } from "zod";
import type { StorePort, DbCommand } from "../domain/ports.js";
import type { Resource, Service } from "../domain/entities.js";
import { ResourceSchema, ServiceSchema } from "../domain/schemas.js";
import { requireCondition } from "../domain/errors.js";
import { changeCommands } from "../domain/events.js";
const lakeSchema = z
  .object({
    id: z.uuid(),
    name: z.string().min(1),
    description: z.string().default(""),
  })
  .strict();
const environmentSchema = z
  .object({
    id: z.uuid(),
    lakeId: z.uuid(),
    name: z.string().min(1),
    classification: z.enum(["development", "test", "production"]),
  })
  .strict();
function noInlineSecrets(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(noInlineSecrets);
    return;
  }
  if (value && typeof value === "object")
    for (const [key, item] of Object.entries(value)) {
      requireCondition(
        !/^(password|apiKey|privateKey|kubeconfig|token|secret)$/i.test(key),
        "invalid_input",
        "Use a private credential reference",
      );
      noInlineSecrets(item);
    }
}
export async function importResources(
  store: StorePort,
  input: unknown,
): Promise<void> {
  const parsed = z
    .object({
      lakes: z.array(lakeSchema).default([]),
      environments: z.array(environmentSchema).default([]),
      resources: z.array(ResourceSchema),
    })
    .strict()
    .parse(input);
  noInlineSecrets(parsed);
  const commands: DbCommand[] = [];
  const lakes = new Set((await store.list<any>("lakes")).map((l) => l.id));
  for (const l of parsed.lakes) {
    requireCondition(!lakes.has(l.id), "conflict");
    lakes.add(l.id);
    commands.push(
      ...changeCommands(
        "lakes",
        { ...l, revision: 1 },
        "lake.created",
        "local-user",
        new Date().toISOString(),
      ),
    );
  }
  const environments = new Map(
    (await store.list<any>("environments")).map((e) => [e.id, e.lakeId]),
  );
  for (const e of parsed.environments) {
    requireCondition(
      lakes.has(e.lakeId) && !environments.has(e.id),
      "invalid_input",
    );
    environments.set(e.id, e.lakeId);
    commands.push(
      ...changeCommands(
        "environments",
        { ...e, revision: 1 },
        "environment.created",
        "local-user",
        new Date().toISOString(),
      ),
    );
  }
  const ids = new Set((await store.list<any>("resources")).map((r) => r.id));
  for (const r of parsed.resources) {
    requireCondition(
      environments.get(r.environmentId) === r.lakeId &&
        !ids.has(r.id) &&
        r.revision === 1,
      "invalid_input",
      "Resource scope or identity conflicts",
    );
    ids.add(r.id);
    const value = JSON.parse(JSON.stringify(r)) as Resource;
    commands.push(
      ...changeCommands(
        "resources",
        value,
        "resource.imported",
        "local-user",
        new Date().toISOString(),
      ),
    );
  }
  await store.transact(commands);
}
export async function importServices(
  store: StorePort,
  input: unknown,
): Promise<void> {
  const values = z.array(ServiceSchema).parse(input);
  noInlineSecrets(values);
  const resources = await store.list<Resource>("resources"),
    ids = new Set((await store.list<Service>("services")).map((s) => s.id));
  const commands: DbCommand[] = [];
  for (const s of values) {
    requireCondition(!ids.has(s.id) && s.revision === 1, "conflict");
    for (const b of s.resourceBindings)
      requireCondition(
        resources.some(
          (r) =>
            r.id === b.resourceId &&
            r.lakeId === s.lakeId &&
            r.environmentId === s.environmentId,
        ),
        "scope_denied",
      );
    if (s.health)
      requireCondition(
        s.resourceBindings.some((b) =>
          resources.some(
            (r) =>
              r.id === b.resourceId &&
              r.kind === "http" &&
              r.endpoint === s.health!.url,
          ),
        ),
        "invalid_input",
        "Health URL must be explicitly bound",
      );
    ids.add(s.id);
  }
  for (const s of values) {
    requireCondition(
      s.dependencies.every((d) => ids.has(d) && d !== s.id),
      "invalid_input",
    );
    commands.push(
      ...changeCommands(
        "services",
        JSON.parse(JSON.stringify(s)) as Service,
        "service.imported",
        "local-user",
        new Date().toISOString(),
      ),
    );
  }
  await store.transact(commands);
}
