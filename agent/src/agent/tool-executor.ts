import type { ToolCall, StorePort } from "../domain/ports.js";
import { toolResult } from "../domain/entities.js";
import type { ToolResult, TaskContract } from "../domain/entities.js";
import { publicError, requireCondition } from "../domain/errors.js";
import { ToolCatalog, type ToolContext } from "./tool-catalog.js";
export class ToolExecutor {
  constructor(
    private readonly catalog: ToolCatalog,
    private readonly store: StorePort,
    private readonly normalize: (
      result: ToolResult,
      context: ToolContext,
    ) => Promise<ToolResult> = async (result) => result,
  ) {}
  async execute(call: ToolCall, context: ToolContext): Promise<ToolResult> {
    try {
      requireCondition(!context.signal.aborted, "cancelled");
      const task = await this.store.get<TaskContract>("tasks", context.taskId);
      requireCondition(task?.sessionId === context.sessionId, "scope_denied");
      requireCondition(
        !task.cancelRequestedAt && task.status !== "cancelled",
        "cancelled",
      );
      requireCondition(
        Date.now() < Date.parse(task.deadline),
        "budget_exhausted",
        "Task deadline has elapsed",
      );
      const spec = this.catalog.resolve(call.function.name, context);
      const parsed = spec.schema.safeParse(JSON.parse(call.function.arguments));
      requireCondition(
        parsed.success,
        "invalid_input",
        "Tool parameters failed validation",
      );
      return await this.normalize(
        await spec.run(parsed.data as Record<string, unknown>, context),
        context,
      );
    } catch (error) {
      return toolResult(null, { status: "error", error: publicError(error) });
    }
  }
}
