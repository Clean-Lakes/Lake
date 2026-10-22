export type SSHConnection = { shell?: "sh" | "bash" | "zsh" | "fish"; host: string; port: number; username: string; authMethod?: "key" | "password"; identityFile?: string; credentialRef?: string };
export type SSHConnectionInput = SSHConnection & { password?: string; passphrase?: string; privateKey?: string };
export type SSHKeyDirectory = { directory: string; keys: { name: string; path: string }[] };

export type Project = {
  id: string;
  name: string;
  createdAt: string;
};

export type ProjectMemorySettings = { projectId: string; useEnabled: boolean; extractionEnabled: boolean; epoch: number; revision: number; settingsRevision: number; publishedRevision: number };
export type ProjectMemoryEntry = { projectId: string; key: string; type: "user" | "feedback" | "project" | "reference"; description: string; body?: string; revision: number; projectRevision: number; verification: string; validUntil: string; expired: boolean; deletedAt: string; createdAt: string; updatedAt: string; sources?: Array<{kind: string; sessionId?: string; turnId?: string; at: string; excerpt?: string}> };
export type ProjectMemoryList = { settings: ProjectMemorySettings; items: ProjectMemoryEntry[]; total: number; projectRevision: number };
export type ProjectMemoryJob = { jobId: string; status: string; attempts: number; lastErrorCode: string; createdAt: string; updatedAt: string; usageJSON: string };

export type Resource = {
  id: string;
  projectId: string;
  name: string;
  kind: "local" | "ssh" | "database" | "docker" | "redis";
  settings?: Record<string, unknown>;
  ssh?: SSHConnection;
  description: string;
  status: "available" | "unavailable";
};

export type WorkSession = {
  id: string;
  projectId: string;
  title: string;
  status: "idle" | "investigating" | "waiting_approval" | "completed" | "failed";
  /** All resources currently in the session project; not a creation-time selection. */
  resourceIds: string[];
  createdAt: string;
  updatedAt: string;
  icon?: string;
  tags?: WorkspaceTag[];
  presentationRevision?: number;
};

export type WorkspaceTag = {id: string; projectId: string; name: string; color: "gray" | "green" | "blue" | "purple" | "orange" | "red"};

export type MessageMention = {kind: "resource" | "skill" | "mcp" | "role"; id: string; label: string; start: number; end: number; resourceKind?: Resource["kind"]};

export type Message = {
  id: string;
  sessionId: string;
  role: "user" | "assistant" | "system";
  text: string;
  mentions?: MessageMention[];
  images?: AIImage[];
  files?: TextFileAttachment[];
  createdAt: string;
};

export type Specialist = {
  id: string;
  sessionId: string;
  name: string;
  task: string;
  status: "working" | "completed" | "failed";
  summary: string | null;
  createdAt: string;
  finishedAt: string | null;
};

/** Independent child tasks, supplied by the runtime rather than inferred from tool calls. */
export type AgentRole = "host" | "application" | "data" | "network" | "change" | "verify" | "plan" | "memory";
export type AgentRunStatus = "queued" | "running" | "waiting_approval" | "waiting_input" | "completed" | "failed" | "cancelled" | "interrupted" | "unknown";
export type AgentRun = {
  liveTextId?: string; liveText?: string;
  activityPhase?: string; activityTool?: string; activityUpdatedAt?: string;
	sreTaskId?:string;
	sreRole?:SREAgentRole;
  automaticSurvey?: boolean;
  workflowStepId?: string;
  id: string;
  sessionId: string;
  rootTurnId?: string;
  role: AgentRole | string;
  name?: string;
  task: string;
  resourceIds: string[];
  status: AgentRunStatus;
  summary?: string;
  evidenceIds?: string[];
  toolCount?: number;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  /** Only the owning execution service can advertise individual cancellation. */
  canCancel?: boolean;
  pending?: AIApproval;
  question?: AIQuestionRequest;
  evidence?: AgentEvidence[];
  usage?: AIUsage;
  budgetSpent?: number;
};
export type AgentEvidence = {id: string; sessionId: string; runId: string; resourceId: string; resourceName?: string; assetRef?: string; title: string; excerpt: string; exitCode: number | null; collectedAt: string};

export type Evidence = {
  id: string;
  sessionId: string;
  specialistId: string | null;
  resourceId: string;
  title: string;
  command: string | null;
  excerpt: string;
  exitCode: number | null;
  collectedAt: string;
};

export type Action = {
  id: string;
  sessionId: string;
  resourceId: string;
  terminalId: string | null;
  contextVersion: number | null;
  command: string;
  risk: "readonly" | "write" | "dangerous";
  riskReason: string;
  reason: string;
  impact: string;
  verification: string;
  status: "pending" | "rejected" | "running" | "succeeded" | "failed" | "unknown";
  exitCode: number | null;
  createdAt: string;
  updatedAt: string;
};

export type TerminalSession = {
  interactive?: boolean;
 writerSessionId?: string; ownerTitle?: string;
  generation: string; outputCapturedAt: string | null; cwd: string | null; shell: "sh" | "bash" | "zsh" | "fish";
  id: string;
  sessionId: string;
  resourceId: string;
  status: "connecting" | "ready" | "busy" | "disconnected" | "unknown";
  holder: "user" | "agent" | null;
  contextVersion: number;
  createdAt: string;
};

export type TerminalEntry = {
  status: "running" | "completed" | "unknown"; generation: string; cwd: string | null; startedAt: string | null; finishedAt: string | null; originSessionId: string | null;
  id: string;
  terminalId: string;
  actor: "user" | "agent";
  command: string;
  output: string;
  exitCode: number | null;
  createdAt: string;
};

export type Catalog = {
  tags?: WorkspaceTag[];
  projects: Project[];
  resources: Resource[];
  resourceTree?: ResourceTreeNode[];
  sessions: WorkSession[];
  terminals?: Array<TerminalSession & { sessionTitle?: string }>;
};

export type QueuedMessage = {id: string; text: string; resourceIds: string[]; references?: Record<string,unknown>[]; mentions?: MessageMention[]; images: Pick<AIImage,"id" | "name" | "mimeType">[]; files: TextFileAttachment[]; createdAt: string};
export type MessageQueue = {paused: boolean; revision: number; lastError: string; items: QueuedMessage[]};
export type QueueOperation = {operation:"pause" | "resume"; revision:number} | {operation:"remove"; revision:number; id:string} | {operation:"edit"; revision:number; id:string; text:string; resourceIds:string[]; references?:Record<string,unknown>[]; mentions?:MessageMention[]} | {operation:"reorder"; revision:number; ids:string[]};
export type SendMessageResult = {queued?: boolean; queuedMessageId?: string; messageQueue?: MessageQueue};

export type ReplyTiming = {messageId:string;startedAt:string;finishedAt:string;status:"running" | "completed" | "cancelled" | "failed" | "interrupted"};

export type SessionSnapshot = {
 conversationMode?: ConversationMode;
	sre?:SRESnapshot;
 replyTimings?:ReplyTiming[];
  messageQueue?: MessageQueue;
 aiBinding?: {terminalId?: string; generation?: string};
  session: WorkSession;
  resources: Resource[];
  resourceTree?: ResourceTreeNode[];
  messages: Message[];
  specialists: Specialist[];
  evidence: Evidence[];
  actions: Action[];
  terminals: TerminalSession[];
  cursor: number;
  ai?: AIView;
  hostKeyTrust?: SSHHostKeyTrust | null;
};

export type ResourceTreeNode = { id: string; projectId: string; parentId: string | null; kind: "folder" | "resource"; name: string; resourceId: string | null; position: number; builtin?: boolean };

export type SSHHostKeyTrust = { id: string; resourceId: string; host: string; port: number; algorithm: string; fingerprint: string; previousFingerprints: string[]; changed: boolean; scope: "lake" };

export type SessionEvent = {
	conversationMode?: ConversationMode;
  seq: number;
  sessionId: string;
  type: "session" | "message" | "specialist" | "evidence" | "action" | "terminal";
  createdAt: string;
  textUpdate?: {target:"card"|"agent";id:string;content:string;cardType?:string;at?:string;rootTurnId?:string;textId?:string};
};

export type TerminalHistory = {
  terminal: TerminalSession;
  entries: TerminalEntry[];
  output: string;
};

/** Interface-visible model configuration. The API key itself is never returned. */
export type ModelSettings = {
  source: "settings" | "environment" | "none";
  managedBy?: "magpie";
  magpie?: {name: string};
  configured: boolean;
  url: string;
  name: string;
  keyConfigured: boolean;
  protocol?: string;
  supportsImageInput?: boolean;
  supportsImageOutput?: boolean;
};

/** Result of the interface's "test connection" check. */
export type ModelTestResult = { ok: boolean; message: string };

/** Models the configured endpoint reports, for the composer's model switcher. */
export type ModelReasoningCapability = {levels: string[]; default?: string; source?: string};
export type ProviderModel = {id: string; name: string; displayName?: string; enabled: boolean; contextWindow?: number; supportsImageInput: boolean; supportsImageOutput: boolean; imageInputMode?: "auto" | "on" | "off"; imageInputDetected?: boolean; reasoningCapability?: ModelReasoningCapability};
export type ModelProvider = {id: string; name: string; baseURL: string; protocol: string; enabled: boolean; keyConfigured: boolean; models: ProviderModel[]};
export type ProviderCatalog = {providers: ModelProvider[]; activeProviderId: string; activeModelId: string; savedProviderId?: string};
export type ProviderInput = Omit<ModelProvider,"id" | "keyConfigured"> & {apiKey?: string | null};
export type AvailableModelEntry = {providerId: string; providerName: string; modelId: string; name: string; displayName: string; contextWindow?: number};
export type AvailableModels = { models: string[]; contextLimits?: Record<string, number>; entries?: AvailableModelEntry[]; activeProviderId?: string; activeModelId?: string; source?: "magpie"; message?: string; imageInputCapabilities?: Record<string, boolean>; reasoningCapabilities?: Record<string, ModelReasoningCapability> };

export type ReasoningSettings = { modelId?: string; levels: string[]; default?: string; source?: string; effort: string };

export type ApiError = { error: string };

export type AICard = { id: string; type: string; title?: string; content?: string; data?: unknown; status: string; at: string };
export type ResourceImportRow = {index: number; name: string; kind: string; folder: string; error: string; host?: string; port?: number; username?: string; driver?: string; database?: string; endpoint?: string; authMethod?: string; hasCredential: boolean};
export type ResourceImportPreview = {planId: string; name: string; notice?: string; resources: ResourceImportRow[]};
export type TextFileAttachment = {sourceId: string; name: string; kind?: "file"; sizeBytes?: number; sha256?: string; mimeType?: string};
export type AIApproval = { id: string; call: { id: string; name: string; arguments: string }; target: string; risk: string; kind?: string; needsTerminal?: boolean; resourceId?: string; terminalId?: string; terminalVersion?: number; confirmation?: string; fingerprint: string; preview?: {before?: string; after?: string; resources?: ResourceImportRow[]} };
export type AIUsage = { input: number; output: number; total: number; known?: boolean; inputKnown?: boolean; outputKnown?: boolean; cachedInput?: number | null };
export type AIContextUsage = { window: number; windowSource?: string; modelId?: string; budget?: number; inputBudget?: number; maxOutput?: number; used: number; usedKnown?: boolean; estimated: boolean; estimatedUsed?: number; lastRequest?: AIUsage; lastRequestAt?: string };
export type AITodo = {content:string;status:"pending"|"in_progress"|"completed";priority?:"high"|"medium"|"low"};
export type AIQuestionOption = {label:string;description?:string;recommended?:boolean};
export type AIUserQuestion = {id:string;title:string;reason?:string;options?:Array<string|AIQuestionOption>;multi_select?:boolean};
export type AIQuestionRequest = {id:string;questions:AIUserQuestion[]};
export type AIOperationOutcome = {id:string;tool:string;target:string;status:string;handle?:string;result?:string;startedAt:string};
export type ConversationMode = "default" | "plan";
export type ConversationModeUpdate = {mode:ConversationMode;cursor:number};
export type ProposedPlan = {id:string;content:string;at:string};
export type AIView = { proposedPlan?: ProposedPlan; operationOutcomes?: AIOperationOutcome[]; todos?: AITodo[]; question?: AIQuestionRequest; session: string; status: string; cards: AICard[]; agentRuns?: AgentRun[]; rootTurnId?: string; delegatedUsage?: AIUsage; pending?: AIApproval; pendingApprovals?: AIApproval[]; usage: AIUsage; context?: AIContextUsage; profile: string; summary?: string; memoryStatus?: string; turns: number; cardsOffset: number; totalCards: number; startedAt?: string; turnStartedAt?: string; turnFinishedAt?: string };
export type AIPreset = { id: string; title: string; content: string };

export type AIImage = { id: string; mimeType: string; base64: string; sizeBytes: number; width: number; height: number; name?: string; url?: string };

export type WorkflowStep = {id:string; role:"host"|"application"|"data"; task:string; resourceIds:string[]};
export type WorkflowTemplate = {id:string; projectId:string; name:string; goal:string; steps:WorkflowStep[]; version:number; createdAt:string; updatedAt:string};
export type WorkflowInput = Pick<WorkflowTemplate,"name"|"goal"|"steps"> & {version?:number};
export type WorkflowRun = {id:string; workflowId:string|null; projectId:string; sessionId:string; template:WorkflowTemplate; status:"running"|"completed"|"failed"|"cancelled"|"interrupted"; error:string; createdAt:string; finishedAt:string|null; agentRuns?:AgentRun[]; waitingApproval?:boolean};
export type WorkflowCatalog = {templates:WorkflowTemplate[]; runs:WorkflowRun[]};

export type NavigationTrashItem = {kind:"project" | "resource" | "folder";id:string;projectId:string;name:string;projectName:string;deletedAt:string};

export interface MCPServerConfig {id:string;name:string;transport:"http"|"sse"|"stdio";enabled:boolean;url:string;command:string;args:string[];headersConfigured:boolean;envConfigured:boolean;timeoutMs?:number;protocolVersion?:string}
export interface MCPToolInfo {name:string;description:string;inputSchema:unknown}
export interface MCPToolCatalog {serverId:string;serverName:string;tools:MCPToolInfo[];count:number}
export interface SkillConfig {name:string;description:string;path:string;source:string;enabled:boolean;managed:boolean}
export interface SkillCatalog {skills:SkillConfig[];roots:string[];defaultRoot:string}

/** Fixed product roles; legacy AgentRole remains compatible. */
export type SREAgentRole = 'coordinator'|'investigator'|'executor'|'verifier';
export type SREAction = {tool:string;arguments:Record<string,unknown>;reason?:string;impact?:string;rollback?:string;stopCondition?:string};
export type SRECheck = {id:string;description:string;kind:'number_threshold'|'boolean_probe'|'manual_attestation';resourceId?:string;probe?:SREAction;path?:string;operator?:string;expected?:unknown;unit?:string;windowSeconds?:number;minSamples?:number};
export type SREPlanStep = {id:string;role:SREAgentRole;kind:'observe'|'analyze'|'act'|'verify'|'summarize';description:string;capability?:string;dependsOn:string[];resourceIds:string[];completionChecks:string[];action?:SREAction};
export type SREPlanRevision = {collaborationVersion?:number;id:string;taskId:string;version:number;goal:string;taskType:'query'|'investigation'|'recovery'|'change';scope:string[];steps:SREPlanStep[];acceptance:SRECheck[];changeReason:string;createdAt:string};
export type SREOperation = {risk?:string;resolutionNote?:string;resolvedBy?:string;resolvedAt?:string;id:string;call:{id:string;name:string;arguments:string};digest:string;resourceId:string;status:string;preparedAt:string;dispatchedAt?:string;finishedAt?:string;approvalId?:string;result?:string};
export type SRERoleReport = {schemaVersion:number;summary:string;facts:{statement:string;evidenceIds:string[]}[];hypotheses:string[];unknowns:string[];nextChecks:string[]};
export type SREStepAttempt = {reusedFromAttemptId?:string;report?:SRERoleReport;id:string;planRunId:string;stepId:string;roleRunId:string;status:string;evidence:AgentEvidence[];operations:SREOperation[];result?:string;startedAt:string;finishedAt?:string};
export type SREPlanRun = {id:string;taskId:string;planRevisionId:string;profileVersion:number;status:string;resumeOfRunId?:string;startedAt:string;finishedAt?:string};
export type SRETranscriptEntry = {toRoleId?:SREAgentRole;evidenceIds?:string[];source?:string;id:string;sessionId:string;taskId:string;roleId:SREAgentRole;roleRunId:string;kind:string;body:string;revision:number;sequence:number;planVersion?:number;attemptId?:string;createdAt:string};
export type SRECheckResult = {checkId:string;status:string;reason:string;evidenceIds:string[];samples:number;value?:unknown;attestedBy?:string;checkedAt:string};
export type SREVerificationResult = {reviewSummary?:string;id:string;taskId:string;planRunId:string;checks:SRECheckResult[];verdict:string;checkedAt:string};
export type SRETask = {id:string;sessionId:string;projectId:string;requestId:string;goal:string;scope:string[];mode:'assist'|'plan_only';status:string;outcome:string;recoveryStatus:string;rootCauseStatus:string;profileId:string;profileVersion:number;revision:number;tokenBudget:number;budgetPolicy?:string;budgetSpent:number;usage:AIUsage;plans:SREPlanRevision[];runs:SREPlanRun[];attempts:SREStepAttempt[];messages:SRETranscriptEntry[];verifications:SREVerificationResult[];error?:string;createdAt:string;updatedAt:string};
export type SRESnapshot = {featureVersion:number;enabled:boolean;tasks:SRETask[]};

export type ScheduleExecution={id:string;scheduled_at:string;started_at?:string;finished_at?:string;status:string;error?:string;task_id?:string;session_id?:string};
export type ScheduledTask={id:string;project_id:string;session_id:string;name:string;at:string;interval_seconds:number;kind:'reminder'|'workflow';message?:string;workflow_id?:string;version?:number;enabled:boolean;revision:number;status:string;last_at?:string;error?:string;task_id?:string;history_count:number;history?:ScheduleExecution[]};
