import type { ToolCall, ModelMessage } from "../domain/ports.js";
import type { ToolResult } from "../domain/entities.js";
import { requireCondition } from "../domain/errors.js";
export class ToolProtocol {
  static validate(calls: ToolCall[]): void {
    const ids = new Set<string>();
    for (const call of calls) {
      requireCondition(!ids.has(call.id), "model_protocol_error");
      ids.add(call.id);
      const args = JSON.parse(call.function.arguments);
      requireCondition(
        args && typeof args === "object" && !Array.isArray(args),
        "invalid_input",
      );
    }
  }
  static settle(call: ToolCall, result: ToolResult): ModelMessage {
    return {
      role: "tool",
      tool_call_id: call.id,
      content: JSON.stringify(result),
    };
  }
}
