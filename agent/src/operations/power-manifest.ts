import { z } from "zod";
export const PowerManifestSchema = z
  .object({
    id: z.enum(["local-files", "ssh", "k8s", "postgres", "http-health"]),
    version: z.literal("0.0.1"),
    description: z.string(),
    requiredResourceKinds: z.array(
      z.enum(["local", "ssh", "k8s", "postgres", "http"]),
    ),
    requiredGrants: z.array(z.enum(["read", "change", "interactive"])),
    tools: z.array(
      z
        .object({
          name: z.string(),
          description: z.string(),
          effect: z.enum(["read", "change", "interactive"]),
          schema: z.string(),
        })
        .strict(),
    ),
    inputSchemas: z.record(z.string(), z.string()),
    effectPolicies: z.record(
      z.string(),
      z.enum(["read", "change", "interactive"]),
    ),
    verificationProfiles: z.array(z.string()),
    adapterFactory: z.enum([
      "local-files",
      "ssh",
      "k8s",
      "postgres",
      "http-health",
    ]),
  })
  .strict();
export type PowerManifest = z.infer<typeof PowerManifestSchema>;
const common = { resourceId: z.uuid() };
const empty = z.object(common).strict();
export const powerSchemas: Record<string, z.ZodType> = {
  empty,
  fileRead: z.object({ ...common, path: z.string().min(1) }).strict(),
  fileSearch: z
    .object({
      ...common,
      path: z.string().default("."),
      query: z.string().min(1).max(200),
    })
    .strict(),
  patch: z
    .object({
      ...common,
      path: z.string(),
      expectedHash: z.string().regex(/^[a-f0-9]{64}$/),
      content: z.string().max(262144),
    })
    .strict(),
  patchApply: z
    .object({
      ...common,
      artifactId: z.uuid(),
      path: z.string(),
      expectedHash: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .strict(),
  unit: z.object({ ...common, unit: z.string().min(1).max(200) }).strict(),
  serviceAction: z
    .object({
      ...common,
      unit: z.string(),
      action: z.enum(["start", "reload", "restart"]),
    })
    .strict(),
  log: z
    .object({
      ...common,
      unit: z.string(),
      lines: z.int().min(1).max(500).default(100),
    })
    .strict(),
  readConfig: z.object({ ...common, path: z.string().min(1) }).strict(),
  replaceConfig: z
    .object({
      ...common,
      path: z.string(),
      expectedHash: z.string().regex(/^[a-f0-9]{64}$/),
      artifactId: z.uuid(),
      rollback: z.boolean().default(true),
    })
    .strict(),
  kube: z
    .object({
      ...common,
      kind: z.enum([
        "pod",
        "deployment",
        "statefulset",
        "service",
        "endpoints",
        "event",
      ]),
      name: z
        .string()
        .regex(/^[a-z0-9][a-z0-9.-]*$/)
        .optional(),
    })
    .strict(),
  kubeLogs: z
    .object({
      ...common,
      name: z.string().regex(/^[a-z0-9][a-z0-9.-]*$/),
      lines: z.int().min(1).max(500).default(100),
    })
    .strict(),
  http: z.object({ ...common, serviceId: z.uuid().optional() }).strict(),
};
