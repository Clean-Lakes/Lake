import type { ModelMessage, ToolDefinition } from "../domain/ports.js";
import { LakeError, requireCondition } from "../domain/errors.js";
export function estimateTokens(
  messages: ModelMessage[],
  tools: ToolDefinition[],
): number {
  return (
    Buffer.byteLength(JSON.stringify(messages)) +
    messages.length * 32 +
    Buffer.byteLength(JSON.stringify(tools)) +
    tools.length * 64
  );
}
export interface ContextInput {
  identity: string;
  baseline: string;
  objective: string;
  constraints: string[];
  shared: unknown;
  inbox: string[];
  skills: unknown;
  loadedSkills: string[];
  history: ModelMessage[];
  tools: ToolDefinition[];
  window: number;
  maxOutput: number;
  summary?: string;
}
export class ContextBuilder {
  build(input: ContextInput): {
    messages: ModelMessage[];
    tokens: number;
    needsCompaction: boolean;
  } {
    const prefix: ModelMessage = {
      role: "system",
      content:
        input.identity +
        "\n" +
        input.baseline +
        "\nSkills catalog:\n" +
        JSON.stringify(input.skills),
    };
    const task: ModelMessage = {
      role: "user",
      content: JSON.stringify({
        objective: input.objective,
        constraints: input.constraints,
        shared: input.shared,
        inbox: input.inbox,
        loadedSkills: input.loadedSkills,
        summary: input.summary ?? null,
      }),
    };
    const messages = [prefix, task, ...input.history];
    const tokens = estimateTokens(messages, input.tools);
    return {
      messages,
      tokens,
      needsCompaction: tokens + input.maxOutput > input.window * 0.7,
    };
  }
  assertFits(tokens: number, maxOutput: number, window: number): void {
    requireCondition(tokens + maxOutput <= window, "context_exhausted");
  }
}
