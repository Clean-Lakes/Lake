import { z } from "zod";
export const ProfileSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    instructions: z.string(),
    extraSkills: z.array(z.string()).default([]),
    defaultPowers: z.array(z.string()).default([]),
    modelOverride: z.string().optional(),
    maxTurns: z.int().positive().max(100).default(30),
  })
  .strict();
export const ProviderSchema = z
  .object({
    id: z.string().min(1),
    baseUrl: z.url(),
    model: z.string().min(1),
    credentialRef: z.string().optional(),
    contextWindowTokens: z.int().min(1024),
    maxOutputTokens: z.int().positive(),
    supportsTools: z.boolean(),
    supportsStreaming: z.boolean().default(true),
    supportsUsageInStream: z.boolean().default(false),
    inputPricePerMillion: z.number().nonnegative().optional(),
    outputPricePerMillion: z.number().nonnegative().optional(),
  })
  .strict()
  .refine((v) => v.maxOutputTokens < v.contextWindowTokens, {
    message: "Output exceeds context window",
  });
export const ConfigSchema = z
  .object({
    schemaVersion: z.literal(1),
    providers: z.array(ProviderSchema),
    defaultProvider: z.string().min(1),
    profiles: z.array(ProfileSchema).default([]),
    trustedSkillRoots: z.array(z.string()).default([]),
    limits: z
      .object({
        maxActiveSpecialists: z.int().min(1).max(3).default(3),
        maxActiveModelRequests: z.int().min(1).max(2).default(2),
        sessionMaxModelCalls: z.int().positive().default(100),
        sessionMaxEstimatedTokens: z.int().positive().default(200000),
        specialistMaxModelCalls: z.int().positive().default(30),
        sessionWallTimeMs: z.int().positive().default(1800000),
        maxMutatingActionsPerTask: z.int().positive().default(5),
        modelRequestTimeoutMs: z.int().positive().default(120000),
        readToolTimeoutMs: z.int().positive().default(30000),
        changeToolTimeoutMs: z.int().positive().default(120000),
        maxReadRetries: z.int().min(0).max(2).default(2),
        maxModelRetries: z.int().min(0).max(2).default(2),
        maxParallelReadsPerResource: z.int().positive().default(2),
        maxParallelWritesPerResource: z.literal(1).default(1),
        terminalInputLeaseMs: z.int().positive().default(30000),
        humanLeaseMs: z.int().positive().default(600000),
        maxInlineToolBytes: z.int().positive().default(65536),
        maxArtifactBytes: z.int().positive().default(10485760),
        maxActionScriptBytes: z.int().positive().default(262144),
        maxApiBodyBytes: z.int().positive().default(1048576),
        maxConsecutiveEquivalentTools: z.int().positive().default(3),
        maxConsecutiveNoProgressModelCalls: z.int().positive().default(5),
      })
      .strict()
      .default({
        maxActiveSpecialists: 3,
        maxActiveModelRequests: 2,
        sessionMaxModelCalls: 100,
        sessionMaxEstimatedTokens: 200000,
        specialistMaxModelCalls: 30,
        sessionWallTimeMs: 1800000,
        maxMutatingActionsPerTask: 5,
        modelRequestTimeoutMs: 120000,
        readToolTimeoutMs: 30000,
        changeToolTimeoutMs: 120000,
        maxReadRetries: 2,
        maxModelRetries: 2,
        maxParallelReadsPerResource: 2,
        maxParallelWritesPerResource: 1,
        terminalInputLeaseMs: 30000,
        humanLeaseMs: 600000,
        maxInlineToolBytes: 65536,
        maxArtifactBytes: 10485760,
        maxActionScriptBytes: 262144,
        maxApiBodyBytes: 1048576,
        maxConsecutiveEquivalentTools: 3,
        maxConsecutiveNoProgressModelCalls: 5,
      }),
  })
  .strict()
  .refine((c) => c.providers.some((p) => p.id === c.defaultProvider), {
    message: "Default provider is missing",
  });
export type Config = z.infer<typeof ConfigSchema>;
export type Provider = z.infer<typeof ProviderSchema>;
