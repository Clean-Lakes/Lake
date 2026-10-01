import type { JsonValue } from "./json.js";
export interface LakeCommand { method: string; params: Record<string, JsonValue>; id?: string }
export interface LakeEvent { type: string; conversation_id?: string; sequence?: number; [key: string]: unknown }
export interface LakeRuntime {
  dispatch(command: LakeCommand): Promise<JsonValue>;
  subscribe(listener: (event: LakeEvent) => void): () => void;
  close(): Promise<void>;
}
export interface LakeRuntimeOptions { root?: string; cliPath?: string; nodePath?: string }
