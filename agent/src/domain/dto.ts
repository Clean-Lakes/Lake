import { z } from "zod";
import {
  Id,
  ResourceSchema,
  ServiceSchema,
  TaskContractSchema,
  CriterionSchema,
} from "./schemas.js";
import { ProfileSchema } from "./config.js";
import { errorCodes } from "./errors.js";

const entity = { id: Id, revision: z.int().positive() };
const scope = { sessionId: Id, taskId: Id };
const date = z.iso.datetime();
export const BudgetSchema = z
  .object({
    calls: z.int().nonnegative(),
    tokens: z.int().nonnegative(),
    reservedCalls: z.int().nonnegative(),
    reservedTokens: z.int().nonnegative(),
    maxCalls: z.int().positive(),
    maxTokens: z.int().positive(),
    deadline: date,
  })
  .strict();
export const SessionSchema = z
  .object({
    ...entity,
    lakeId: Id,
    environmentId: Id,
    status: z.enum([
      "active",
      "waiting",
      "succeeded",
      "qualified",
      "failed",
      "cancelled",
    ]),
    rootTaskId: Id,
    providerId: z.string(),
    eventCursor: z.string().regex(/^\d+$/),
    budget: BudgetSchema,
    cancelRequestedAt: date.optional(),
  })
  .strict();
export const LakeSchema = z
  .object({ ...entity, name: z.string(), description: z.string() })
  .strict();
export const EnvironmentSchema = z
  .object({
    ...entity,
    lakeId: Id,
    name: z.string(),
    classification: z.enum(["development", "test", "production"]),
  })
  .strict();
export const StepSchema = z
  .object({
    ...entity,
    ...scope,
    label: z.string(),
    dependencies: z.array(Id),
    assignee: z.string().optional(),
    status: z.enum([
      "pending",
      "claimed",
      "running",
      "waiting",
      "verifying",
      "succeeded",
      "failed",
      "blocked",
      "cancelled",
    ]),
    evidenceIds: z.array(Id),
  })
  .strict();
export const SkillSnapshotSchema = z
  .object({
    name: z.string(),
    version: z.string(),
    description: z.string(),
    whenToUse: z.string(),
    body: z.string(),
    digest: z.string(),
    source: z.string(),
  })
  .strict();
export const WorkOrderSchema = z
  .object({
    objective: z.string(),
    stepIds: z.array(Id),
    resourceIds: z.array(Id),
    acceptanceCriteria: z.array(CriterionSchema),
    constraints: z.array(z.string()),
    skillSnapshot: z.array(SkillSnapshotSchema),
    inboxCursor: z.int().nonnegative(),
  })
  .strict();
export const SpecialistStateSchema = z
  .object({
    status: z.enum([
      "queued",
      "running",
      "waiting",
      "succeeded",
      "failed",
      "cancelled",
      "interrupted",
    ]),
    phase: z.enum([
      "collecting",
      "diagnosing",
      "planning",
      "remediating",
      "verifying",
      "observing",
      "reporting",
    ]),
    activity: z.enum([
      "idle",
      "model_call",
      "loading_skill",
      "opening_terminal",
      "attaching_terminal",
      "reading_logs",
      "querying_resource",
      "executing_command",
      "editing_config",
      "verifying_health",
      "waiting_input_control",
      "waiting_approval",
      "waiting_dependency",
      "reconciling",
    ]),
    taskId: Id,
    since: date,
    updatedAt: date,
    revision: z.int().positive(),
    actionId: Id.optional(),
    terminalSessionId: Id.optional(),
    waitingReason: z.string().optional(),
  })
  .strict();
export const SpecialistRunSchema = z
  .object({
    ...entity,
    ...scope,
    profileId: z.string(),
    profileDigest: z.string(),
    profile: ProfileSchema,
    workOrder: WorkOrderSchema,
    modelSessionId: Id,
    state: SpecialistStateSchema,
    powerBindings: z.array(z.string()),
    budget: BudgetSchema,
    cancelRequestedAt: date.optional(),
  })
  .strict();
export const ExecutionSessionSchema = z
  .object({
    ...entity,
    sessionId: Id,
    resourceId: Id,
    resourceIdentity: z.string(),
    powerId: z.string(),
    mode: z.enum(["managed", "interactive"]),
    status: z.enum([
      "opening",
      "ready",
      "disconnected",
      "reconciling",
      "closed",
    ]),
    cwd: z.string(),
    inputHolder: z.string().nullable(),
    inputEpoch: z.int().nonnegative(),
    inputExpiresAt: date.nullable(),
    outputCursor: z.string().regex(/^\d+$/),
    paused: z.boolean(),
    controlApprovalId: Id.optional(),
    controlExpiredAt: date.optional(),
  })
  .strict();
export const PublicErrorSchema = z
  .object({
    code: z.enum(errorCodes),
    message: z.string(),
    retryable: z.boolean(),
    actionId: Id.optional(),
    details: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export const ToolResultSchema = z
  .object({
    status: z.enum(["ok", "error", "waiting"]),
    data: z.unknown(),
    artifactRefs: z.array(Id),
    truncated: z.boolean(),
    retryPolicy: z.enum(["never", "safe_read"]),
    actionId: Id.optional(),
    error: PublicErrorSchema.optional(),
  })
  .strict();
export const ActionSchema = z
  .object({
    ...entity,
    ...scope,
    actor: z.string(),
    capability: z.string(),
    effect: z.enum(["read", "change", "interactive"]),
    targets: z.array(
      z
        .object({ id: Id, identity: z.string(), revision: z.int().positive() })
        .strict(),
    ),
    parameters: z.record(z.string(), z.unknown()),
    proposalDigest: z.string(),
    status: z.enum([
      "proposed",
      "waiting_approval",
      "authorized",
      "queued",
      "dispatched",
      "observed",
      "verifying",
      "succeeded",
      "failed",
      "blocked",
      "cancelled",
      "unknown",
    ]),
    taskRevision: z.int().positive(),
    terminalSessionId: Id.optional(),
    inputEpoch: z.int().nonnegative().optional(),
    attemptId: Id.optional(),
    callKey: z.string(),
    preconditionRefs: z.array(Id),
    verificationRefs: z.array(Id),
    approvalId: Id.optional(),
    result: ToolResultSchema.optional(),
    cancelRequestedAt: date.optional(),
    createdAt: date,
  })
  .strict();
const fact = {
  ...entity,
  ...scope,
  resourceId: Id,
  source: z.string(),
  observedAt: date,
  expiresAt: date,
  fingerprint: z.string(),
  trusted: z.boolean(),
  invalidatedAt: date.optional(),
  artifactRef: Id.optional(),
};
export const ApprovalSchema = z
  .object({
    ...entity,
    ...scope,
    principal: z.string(),
    actionId: Id.optional(),
    actionDigest: z.string(),
    targetDigest: z.string(),
    expiresAt: date,
    maxUses: z.int().positive(),
    consumedUses: z.int().nonnegative(),
    revokedAt: date.optional(),
    consumedBy: z.string().optional(),
  })
  .strict();
export const GrantSchema = z
  .object({
    ...entity,
    lakeId: Id,
    environmentId: Id,
    resourceId: Id,
    resourceIdentity: z.string(),
    resourceRevision: z.int().positive(),
    effects: z.array(z.enum(["read", "change", "interactive"])),
    principal: z.string(),
    revokedAt: date.optional(),
  })
  .strict();
export const ObservationSchema = z
  .object({ ...fact, value: z.unknown(), actionId: Id.optional() })
  .strict();
export const EvidenceSchema = z
  .object({
    ...fact,
    actionId: Id,
    resourceIdentity: z.string(),
    criterionId: z.string(),
    result: z.boolean(),
  })
  .strict();
export const HypothesisSchema = z
  .object({
    ...entity,
    ...scope,
    claim: z.string(),
    status: z.enum(["candidate", "supported", "refuted", "confirmed"]),
    supportingEvidence: z.array(Id),
    refutingEvidence: z.array(Id),
    nextProbe: z.string(),
  })
  .strict();
export const SessionMessageSchema = z
  .object({
    ...entity,
    sessionId: Id,
    text: z.string(),
    actor: z.string(),
    createdAt: date,
  })
  .strict();
export const SnapshotSchema = z
  .object({
    session: SessionSchema,
    cursor: z.string().regex(/^\d+$/),
    tasks: z.array(TaskContractSchema),
    task_steps: z.array(StepSchema),
    specialist_runs: z.array(SpecialistRunSchema),
    execution_sessions: z.array(ExecutionSessionSchema),
    actions: z.array(ActionSchema),
    observations: z.array(ObservationSchema),
    hypotheses: z.array(HypothesisSchema),
    evidence: z.array(EvidenceSchema),
    session_messages: z.array(SessionMessageSchema),
    resources: z.array(
      ResourceSchema.refine(
        (r) => r.credentialRef === undefined,
        "Private credential reference is excluded",
      ),
    ),
    services: z.array(ServiceSchema),
  })
  .strict();
