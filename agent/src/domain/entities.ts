export interface Entity {
  id: string;
  revision: number;
  [key: string]: unknown;
}
export interface Lake extends Entity {
  name: string;
  description: string;
}
export interface Environment extends Entity {
  lakeId: string;
  name: string;
  classification: "development" | "test" | "production";
}
export type ResourceKind = "ssh" | "k8s" | "postgres" | "local" | "http";
export type Effect = "read" | "change" | "interactive";
export interface Resource extends Entity {
  lakeId: string;
  environmentId: string;
  kind: ResourceKind;
  name: string;
  endpoint: string;
  identity: string;
  credentialRef?: string;
  settings: Record<string, unknown>;
}
export interface HealthProfile {
  url: string;
  statuses: number[];
  bodyIncludes?: string;
  timeoutMs: number;
  intervalMs: number;
  successes: number;
  maxWaitMs: number;
}
export interface Service extends Entity {
  lakeId: string;
  environmentId: string;
  name: string;
  resourceBindings: {
    resourceId: string;
    locator: Record<string, unknown>;
  }[];
  dependencies: string[];
  health?: HealthProfile;
}
export interface Criterion {
  id: string;
  label: string;
  type: "observation" | "http_health" | "manual";
  required: boolean;
  resourceId?: string;
  confirmedBy?: string;
}
export type TaskStatus =
  | "active"
  | "waiting"
  | "succeeded"
  | "qualified"
  | "failed"
  | "cancelled";
export interface Session extends Entity {
  createdAt?: string;
  parentSessionId?: string;
  invocation?: Invocation;
  lakeId: string;
  environmentId: string;
  status: TaskStatus;
  rootTaskId: string;
  providerId: string;
  eventCursor: string;
  budget: Budget;
  cancelRequestedAt?: string;
}
export interface Budget {
  calls: number;
  tokens: number;
  reservedCalls: number;
  reservedTokens: number;
  maxCalls: number;
  maxTokens: number;
  deadline: string;
}
export interface TaskContract extends Entity {
  intent?: "diagnose" | "recover" | "change";
  contractRevision?: number;
  waitingReason?: string;
  sessionId: string;
  objective: string;
  scope: string[];
  constraints: string[];
  acceptanceCriteria: Criterion[];
  status: TaskStatus;
  deadline: string;
  cancelRequestedAt?: string;
}
export type StepStatus =
  | "pending"
  | "claimed"
  | "running"
  | "waiting"
  | "verifying"
  | "succeeded"
  | "failed"
  | "blocked"
  | "cancelled";
export interface TaskStep extends Entity {
  taskId: string;
  sessionId: string;
  label: string;
  dependencies: string[];
  assignee?: string;
  status: StepStatus;
  evidenceIds: string[];
}
export type SpecialistStatus =
  | "queued"
  | "running"
  | "waiting"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "interrupted";
export type Phase =
  | "collecting"
  | "diagnosing"
  | "planning"
  | "remediating"
  | "verifying"
  | "observing"
  | "reporting";
export type Activity =
  | "idle"
  | "model_call"
  | "loading_skill"
  | "opening_terminal"
  | "attaching_terminal"
  | "reading_logs"
  | "querying_resource"
  | "executing_command"
  | "editing_config"
  | "verifying_health"
  | "waiting_input_control"
  | "waiting_approval"
  | "waiting_dependency"
  | "reconciling";
export interface SpecialistState {
  status: SpecialistStatus;
  phase: Phase;
  activity: Activity;
  taskId: string;
  since: string;
  updatedAt: string;
  revision: number;
  actionId?: string;
  terminalSessionId?: string;
  waitingReason?: string;
}
export interface SkillSnapshot {
  name: string;
  version: string;
  description: string;
  whenToUse: string;
  body: string;
  digest: string;
  source: string;
}
export interface SpecialistProfile {
  id: string;
  name: string;
  instructions: string;
  extraSkills: string[];
  defaultPowers: string[];
  maxTurns: number;
  modelOverride?: string;
}
export interface WorkOrder {
  objective: string;
  stepIds: string[];
  resourceIds: string[];
  acceptanceCriteria: Criterion[];
  constraints: string[];
  skillSnapshot: SkillSnapshot[];
  inboxCursor: number;
}
export interface SpecialistRun extends Entity {
  sessionId: string;
  taskId: string;
  profileId: string;
  profileDigest: string;
  profile: SpecialistProfile;
  workOrder: WorkOrder;
  modelSessionId: string;
  state: SpecialistState;
  powerBindings: string[];
  budget: Budget;
}
export type TerminalStatus =
  | "opening"
  | "ready"
  | "disconnected"
  | "reconciling"
  | "closed";
export interface ExecutionSession extends Entity {
  sessionId: string;
  resourceId: string;
  resourceIdentity: string;
  powerId: string;
  mode: "managed" | "interactive";
  status: TerminalStatus;
  cwd: string;
  inputHolder: string | null;
  inputEpoch: number;
  inputExpiresAt: string | null;
  outputCursor: string;
  paused: boolean;
}
export type ActionStatus =
  | "proposed"
  | "waiting_approval"
  | "authorized"
  | "queued"
  | "dispatched"
  | "observed"
  | "verifying"
  | "succeeded"
  | "failed"
  | "blocked"
  | "cancelled"
  | "unknown";
export interface Action extends Entity {
  sessionId: string;
  taskId: string;
  actor: string;
  capability: string;
  effect: Effect;
  targets: {
    id: string;
    identity: string;
    revision: number;
  }[];
  parameters: Record<string, unknown>;
  proposalDigest: string;
  status: ActionStatus;
  taskRevision: number;
  terminalSessionId?: string;
  inputEpoch?: number;
  attemptId?: string;
  callKey: string;
  preconditionRefs: string[];
  verificationRefs: string[];
  approvalId?: string;
  result?: ToolResult;
  cancelRequestedAt?: string;
  createdAt: string;
}
export interface Observation extends Entity {
  sessionId: string;
  taskId: string;
  resourceId: string;
  source: string;
  observedAt: string;
  expiresAt: string;
  fingerprint: string;
  value: unknown;
  trusted: boolean;
  actionId?: string;
  invalidatedAt?: string;
  artifactRef?: string;
}
export interface Evidence extends Entity {
  sessionId: string;
  taskId: string;
  actionId: string;
  resourceId: string;
  resourceIdentity: string;
  criterionId: string;
  source: string;
  observedAt: string;
  expiresAt: string;
  fingerprint: string;
  result: boolean;
  trusted: boolean;
  invalidatedAt?: string;
  artifactRef?: string;
}
export interface Hypothesis extends Entity {
  taskId: string;
  sessionId: string;
  claim: string;
  status: "candidate" | "supported" | "refuted" | "confirmed";
  supportingEvidence: string[];
  refutingEvidence: string[];
  nextProbe: string;
}
export interface Approval extends Entity {
  sessionId: string;
  taskId: string;
  principal: string;
  actionDigest: string;
  targetDigest: string;
  expiresAt: string;
  maxUses: number;
  consumedUses: number;
  revokedAt?: string;
  consumedBy?: string;
}
export interface Grant extends Entity {
  lakeId: string;
  environmentId: string;
  resourceId: string;
  resourceIdentity: string;
  resourceRevision: number;
  effects: Effect[];
  principal: string;
  revokedAt?: string;
}
export interface ToolResult {
  status: "ok" | "waiting" | "error";
  data: unknown;
  artifactRefs: string[];
  truncated: boolean;
  retryPolicy: "never" | "safe_read";
  actionId?: string;
  error?: {
    code: string;
    message: string;
    retryable: boolean;
  };
}
export function toolResult(
  data: unknown,
  extra: Partial<ToolResult> = {},
): ToolResult {
  return {
    status: "ok",
    data,
    artifactRefs: [],
    truncated: false,
    retryPolicy: "never",
    ...extra,
  };
}
import type { Invocation } from "./invocation.js";
