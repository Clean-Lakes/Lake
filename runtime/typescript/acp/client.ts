/** Provider-neutral boundary. Protocol frames never enter the task runtime. */
export type AgentLaunch = {
  executable: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv;
  threadConfig?: Record<string, unknown>;
  observed?: {model:string;modelProvider:string;reasoningEffort?:string;authenticated:boolean;authMode:'chatgpt'|'api_key'|'provider'|'none'};
};
export type AgentActivity =
  | {kind:'input';inputId:string}
  | {kind:'text';text:string;messageId:string;messageText:string}
  | ({kind:'tool'|'tool_update';callId:string;title:string;status:string;transient?:boolean;scopedTool?:boolean} & Partial<import('./codex-activity').CodexDetail>)
  | {kind:'usage';usage:{inputTokens:number;outputTokens:number}};
export type AgentTurnResult = {stopReason:'end_turn'|'cancelled'|'failed';error?:string};
export interface AgentConnection {
  initialize(signal:AbortSignal):Promise<Record<string,unknown>>;
  openSession(options:{cwd:string;threadId?:string;systemPrompt?:string},signal:AbortSignal):Promise<string>;
  exec(text:string,signal:AbortSignal):Promise<AgentTurnResult>;
  steer(text:string,inputId:string,signal:AbortSignal):Promise<boolean>;
  cancel():Promise<void>;
  diagnostics():string;
  close():Promise<void>;
}
type ScopedTools = {tools:import('./bridge').BridgeTool[];guard:()=>void};
export type ScopedStdioMcp = ScopedTools & {command:string;args:string[]};
export type ScopedHttpMcp = ScopedTools & {serverUrl:string;headers:Record<string,string>};
export type ObserveAgentModel = (model:string,provider:string,reasoningEffort?:string)=>void;
