import type { ToolEntry, ToolExecutionContext } from "@zcode/core";
import type { PermissionRuleset } from "@zcode/contracts";
import type { LayeredMemoryActor } from "../../web-agent/shared/contracts";

/** Host-issued child attribution; never accepted from model arguments. */
export type HostToolContext = ToolExecutionContext & {
  lakeSubagent?: { id: string; sessionId: string; toolCallId: string };
};

export type HostProfile = {
  version: string;
  systemPrompt: string;
  tools: ToolEntry[];
  allowlist: string[];
  subagents?: boolean;
  taskId?: string;
  workerId?: string;
  memoryActor?: LayeredMemoryActor;
  recordModel?: (stage: "start" | "success" | "error", operation?: string, usage?: {inputTokens?:number;outputTokens?:number}) => void;
  beforeModel?: () => void;
  configureTool?: (entry: ToolEntry) => ToolEntry;
  permissionRules?: PermissionRuleset;
  projectRequest?: <T>(request: T) => T;
  invoke?: (entry: ToolEntry, input: unknown, context: HostToolContext) => Promise<unknown>;
  /** Native child controls use the task lease, without creating business evidence. */
  invokeControl?: (entry: ToolEntry, input: unknown, context: HostToolContext) => Promise<unknown>;
};
export interface AgentHost {
  profile(sessionId: string): HostProfile | undefined;
  changed(sessionId: string): void;
  settled(sessionId: string, outcome?: { response?: string; error?: string }): void;
}
