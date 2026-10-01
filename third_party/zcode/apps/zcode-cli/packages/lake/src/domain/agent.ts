import type { JsonValue } from "./json.js";
import type { Params } from "./validation.js";
import type { LakeEvent } from "./protocol.js";
export interface LakeTool {
  name: string; description: string; inputSchema: Params;
  call(params: Params, signal: AbortSignal): Promise<JsonValue>;
}
export interface AgentPort {
  close?(): Promise<void>;
  respond?(id: string, params: Params): Promise<boolean>;
  inspect?(input: Params): Promise<JsonValue>;
  run(input: Params, tools: LakeTool[], signal: AbortSignal, emit: (event: LakeEvent) => void): Promise<string>;
}
