import type { JsonValue } from "../domain/json.js";
import type { LakeEvent, LakeRuntimeOptions } from "../domain/protocol.js";
import type { Params } from "../domain/validation.js";
import type { AgentPort } from "../domain/agent.js";

export interface DataPort { request(method: string, params: Params): Promise<JsonValue>; close(): void }
export interface SettingsPort { request(params: Params): Promise<JsonValue> }
export interface ExecutionPort {
  request(method: string, params: Params, signal: AbortSignal): Promise<JsonValue>;
  close(): Promise<void>;
}
export interface RuntimePorts {
  data: DataPort; settings: SettingsPort; execution: ExecutionPort;
  options: LakeRuntimeOptions; emit(event: LakeEvent): void;
  id(): string;
  agent?: AgentPort;
}
