import { z } from "zod";
export const InvocationSchema = z
  .object({
    cwd: z.string().optional(),
    workspaceRoots: z.array(z.string()).optional(),
    sandboxMode: z
      .enum(["read-only", "workspace-write", "danger-full-access"])
      .default("workspace-write"),
    approvalPolicy: z
      .enum(["untrusted", "on-request", "never"])
      .default("on-request"),
    bypassApprovals: z.boolean().default(false),
    model: z.string().optional(),
    reasoningEffort: z
      .enum(["minimal", "low", "medium", "high", "xhigh", "max", "ultra"])
      .optional(),
    maxCalls: z.int().positive().optional(),
    maxTokens: z.int().positive().optional(),
  })
  .strict();
export type Invocation = z.infer<typeof InvocationSchema>;
export const CliPreferencesSchema = z
  .object({
    defaults: z.record(z.string(), z.unknown()).default({}),
    profiles: z
      .record(z.string(), z.record(z.string(), z.unknown()))
      .default({}),
  })
  .strict();
