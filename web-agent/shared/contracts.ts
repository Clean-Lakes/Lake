export type SSHConnection = { shell?: "sh" | "bash" | "zsh" | "fish"; host: string; port: number; username: string; authMethod?: "key" | "password"; identityFile?: string; credentialRef?: string };
export type SSHConnectionInput = SSHConnection & { password?: string; passphrase?: string; privateKey?: string };
export type SSHKeyDirectory = { directory: string; keys: { name: string; path: string }[] };

export type Project = {
  id: string;
  name: string;
  createdAt: string;
};

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
};

export type Message = {
  id: string;
  sessionId: string;
  role: "user" | "assistant" | "system";
  text: string;
  images?: AIImage[];
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
  projects: Project[];
  resources: Resource[];
  resourceTree?: ResourceTreeNode[];
  sessions: WorkSession[];
  terminals?: Array<TerminalSession & { sessionTitle?: string }>;
};

export type SessionSnapshot = {
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

export type ResourceTreeNode = { id: string; projectId: string; parentId: string | null; kind: "folder" | "resource"; name: string; resourceId: string | null; position: number };

export type SSHHostKeyTrust = { id: string; resourceId: string; host: string; port: number; algorithm: string; fingerprint: string; previousFingerprints: string[]; changed: boolean; scope: "lake" };

export type SessionEvent = {
  seq: number;
  sessionId: string;
  type: "session" | "message" | "specialist" | "evidence" | "action" | "terminal";
  createdAt: string;
};

export type TerminalHistory = {
  terminal: TerminalSession;
  entries: TerminalEntry[];
  output: string;
};

/** Interface-visible model configuration. The API key itself is never returned. */
export type ModelSettings = {
  source: "settings" | "environment" | "none";
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
export type AvailableModels = { models: string[]; message?: string };

export type ReasoningSettings = { modelId?: string; levels: string[]; default?: string; source?: string; effort: string };

export type ApiError = { error: string };

export type AICard = { id: string; type: string; title?: string; content?: string; data?: unknown; status: string; at: string };
export type AIApproval = { id: string; call: { id: string; name: string; arguments: string }; target: string; risk: string; kind?: string; needsTerminal?: boolean; resourceId?: string; terminalId?: string; terminalVersion?: number; confirmation?: string; fingerprint: string; preview?: {before: string; after: string} };
export type AIUsage = { input: number; output: number; total: number; known?: boolean; inputKnown?: boolean; outputKnown?: boolean; cachedInput?: number | null };
export type AIContextUsage = { window: number; windowSource?: string; modelId?: string; budget?: number; used: number; usedKnown?: boolean; estimated: boolean; estimatedUsed?: number; lastRequest?: AIUsage; lastRequestAt?: string };
export type AIView = { session: string; status: string; cards: AICard[]; pending?: AIApproval; usage: AIUsage; context?: AIContextUsage; profile: string; summary?: string; turns: number; cardsOffset: number; totalCards: number; startedAt?: string; turnStartedAt?: string; turnFinishedAt?: string };
export type AIPreset = { id: string; title: string; content: string };

export type AIImage = { id: string; mimeType: string; base64: string; sizeBytes: number; width: number; height: number; name?: string; url?: string };
