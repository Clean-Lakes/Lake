import type { Entity, ToolResult, Resource } from "./entities.js";
import type { DomainEvent, EventInput } from "./events.js";
export type DbCommand =
  | {
      op: "get";
      table: string;
      id: string;
    }
  | {
      op: "cursor";
      streamId: string;
    }
  | {
      op: "list";
      table: string;
    }
  | {
      op: "put";
      table: string;
      value: Entity;
      expectedRevision: number;
    }
  | {
      op: "delete";
      table: string;
      id: string;
      expectedRevision: number;
    }
  | {
      op: "event";
      event: EventInput;
    }
  | {
      op: "lock";
      resourceId: string;
      owner: string;
      mode: "read" | "write";
      maxReads: number;
    }
  | {
      op: "unlock";
      owner: string;
    }
  | {
      op: "events";
      streamId: string;
      after: string;
      limit: number;
    }
  | {
      op: "backup";
      path: string;
    };
export interface StorePort {
  transact(commands: DbCommand[]): Promise<unknown[]>;
  get<T = Entity>(table: string, id: string): Promise<T | undefined>;
  list<T = Entity>(table: string): Promise<T[]>;
  close(): Promise<void>;
}
export interface CredentialPort {
  resolve(ref: string): Promise<BufferLike>;
}
export type BufferLike = Uint8Array;
export interface ModelMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}
export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}
export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}
export interface ModelRequest {
  messages: ModelMessage[];
  tools: ToolDefinition[];
  maxOutputTokens: number;
  signal: AbortSignal;
}
export interface ModelUsage {
  input: number;
  output: number;
  cached: number | null;
}
export type ModelEvent =
  | {
      type: "text";
      text: string;
    }
  | {
      type: "complete";
      message: ModelMessage;
      usage: ModelUsage | null;
    };
export interface ModelPort {
  stream(request: ModelRequest): AsyncIterable<ModelEvent>;
}
export interface ExecutionAdapterPort {
  execute(
    capability: string,
    resource: Resource,
    parameters: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<ToolResult>;
}
export interface VerificationPort {
  run(actionId: string): Promise<ToolResult>;
}
export interface ReconciliationPort {
  reconcile(actionId: string): Promise<ToolResult>;
}
export interface OperationGatewayPort {
  execute(proposal: unknown, signal: AbortSignal): Promise<ToolResult>;
}
export interface ClockPort {
  now(): Date;
}
export interface EventPort {
  append(input: EventInput): Promise<DomainEvent>;
}
