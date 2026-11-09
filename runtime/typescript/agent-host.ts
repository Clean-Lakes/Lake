import type { ToolEntry, ToolExecutionContext } from "./sdk";
import type { ExecutionPort, FileSystemPort, HttpClientPort, PermissionRuleset } from "./sdk";
import type { LayeredMemoryActor } from "../../web-agent/shared/contracts";

/** Host-issued child attribution; never accepted from model arguments. */
export type HostToolContext = ToolExecutionContext & {
  lakeSubagent?: { id: string; sessionId: string; toolCallId: string;agentType?:string };
};

export type HostProfile = {
  version: string;
  runtimeMode?:"build"|"plan";
  systemPrompt: string;
  tools: ToolEntry[];
  allowlist: string[];
  subagents?: boolean;
  wrapHTTP?: (http: HttpClientPort) => HttpClientPort;
  wrapFilesystem?: (filesystem: FileSystemPort) => FileSystemPort;
  wrapExecution?: (execution: ExecutionPort) => ExecutionPort;
  taskId?: string;
  workerId?: string;
  memoryActor?: LayeredMemoryActor;
  recordModel?: (stage: "start" | "success" | "error", operation?: string, usage?: {inputTokens?:number;outputTokens?:number}) => void;
  beforeModel?: () => void;
  /** Request one SDK-native, presentation-only continuation when business work lacks its public report. */
  requestFinalReport?: () => boolean;
  configureTool?: (entry: ToolEntry) => ToolEntry;
  permissionRules?: PermissionRuleset;
  projectRequest?: <T>(request: T) => T;
  invoke?: (entry: ToolEntry, input: unknown, context: HostToolContext) => Promise<unknown>;
  /** Native child controls use the task lease, without creating business evidence. */
  invokeControl?: (entry: ToolEntry, input: unknown, context: HostToolContext) => Promise<unknown>;
};
export interface AgentHost {
  profile(sessionId: string): HostProfile | undefined;
  currentTask?(sessionId:string):string|undefined;
  changed(sessionId: string): void;
  settled(sessionId: string, outcome?: { response?: string; error?: string; failure?: import("./model-errors").TurnFailure }): void;
}
