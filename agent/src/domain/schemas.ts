import { z } from "zod";
export const Id = z.uuid();
const record = z.record(z.string(), z.unknown());
export const ResourceSchema = z
  .object({
    id: Id,
    revision: z.int().positive().default(1),
    lakeId: Id,
    environmentId: Id,
    kind: z.enum(["ssh", "k8s", "postgres", "local", "http"]),
    name: z.string().min(1),
    endpoint: z.string().min(1),
    identity: z.string().min(1),
    credentialRef: z.string().min(1).optional(),
    settings: record.default({}),
  })
  .strict()
  .superRefine((r, ctx) => {
    if (r.kind === "local") return;
    try {
      const url = new URL(r.endpoint);
      if (
        url.username ||
        url.password ||
        [...url.searchParams.keys()].some((k) =>
          /key|token|secret|password|signature|auth/i.test(k),
        )
      )
        ctx.addIssue({
          code: "custom",
          path: ["endpoint"],
          message: "Use a private credential reference",
        });
    } catch {
      ctx.addIssue({
        code: "custom",
        path: ["endpoint"],
        message: "Endpoint URL is invalid",
      });
    }
  });
export const CriterionSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    type: z.enum(["observation", "http_health", "manual"]),
    required: z.boolean().default(true),
    resourceId: Id.optional(),
    confirmedBy: z.string().optional(),
  })
  .strict();
export const HealthProfileSchema = z
  .object({
    url: z.url(),
    statuses: z.array(z.int().min(100).max(599)).min(1).default([200]),
    bodyIncludes: z.string().optional(),
    timeoutMs: z.int().positive().max(30000).default(5000),
    intervalMs: z.int().min(10).default(2000),
    successes: z.int().positive().max(20).default(3),
    maxWaitMs: z.int().positive().max(300000).default(60000),
  })
  .strict();
export const ServiceSchema = z
  .object({
    id: Id,
    revision: z.int().positive().default(1),
    lakeId: Id,
    environmentId: Id,
    name: z.string().min(1),
    resourceBindings: z
      .array(z.object({ resourceId: Id, locator: record }).strict())
      .min(1),
    dependencies: z.array(Id).default([]),
    health: HealthProfileSchema.optional(),
  })
  .strict();
export const TaskContractSchema = z
  .object({
    id: Id,
    revision: z.int().positive(),
    sessionId: Id,
    objective: z.string().min(1),
    intent: z.enum(["diagnose", "recover", "change"]).optional(),
    scope: z.array(Id),
    constraints: z.array(z.string()),
    acceptanceCriteria: z.array(CriterionSchema).min(1),
    status: z.enum([
      "active",
      "waiting",
      "succeeded",
      "qualified",
      "failed",
      "cancelled",
    ]),
    deadline: z.iso.datetime(),
    cancelRequestedAt: z.iso.datetime().optional(),
    contractRevision: z.int().positive().optional(),
    waitingReason: z.string().optional(),
    reportArtifactId: Id.optional(),
  })
  .strict();
export const ActionProposalSchema = z
  .object({
    sessionId: Id,
    taskId: Id,
    actor: z.string().min(1),
    capability: z.string().min(1).max(100),
    resourceId: Id,
    parameters: record.default({}),
    callKey: z.string().min(1),
    terminalSessionId: Id.optional(),
    inputEpoch: z.int().nonnegative().optional(),
  })
  .strict();
export const MessageSchema = z
  .object({ text: z.string().min(1).max(65536), specialistId: Id.optional() })
  .strict();
const privateKeys =
  /^(credential[_-]?ref|api[_-]?key|password|passwd|private[_-]?key|kubeconfig|authorization|secret|token|access[_-]?token)$/i;
export function publicProjection(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(publicProjection);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !privateKeys.test(key))
        .map(([key, item]) => [key, publicProjection(item)]),
    );
  return value;
}
