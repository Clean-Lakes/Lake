import type { ToolEntry, ToolExecutionContext } from "@zcode/core";
import type { PermissionRuleset } from "@zcode/contracts";

export type HostProfile = {
  version: string;
  systemPrompt: string;
  tools: ToolEntry[];
  allowlist: string[];
  beforeModel?: () => void;
  configureTool?: (entry: ToolEntry) => ToolEntry;
  permissionRules?: PermissionRuleset;
  projectRequest?: <T>(request: T) => T;
  invoke?: (entry: ToolEntry, input: unknown, context: ToolExecutionContext) => Promise<unknown>;
};
export interface AgentHost {
  profile(sessionId: string): HostProfile | undefined;
  changed(sessionId: string): void;
  settled(sessionId: string): void;
}
