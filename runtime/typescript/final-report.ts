import type { HookRunner } from "./sdk";
import { finalSummaryGuidance } from "./super-prompts";

// Finish inside the SDK's original product turn. This is not a second model
// loop or a new task; the original lease, cancellation and acceptance still apply.
export const finalReportReminder = `LAKE_FINAL_REPORT_REQUIRED: You have not submitted the user-facing conclusion for this invocation. Writing or appending an investigation/progress file is not the chat deliverable. Summarize the actual findings already obtained, what they mean, and any unresolved part in the user's language. ${finalSummaryGuidance} Submit that text with work_finish(summary, outcome). Use partial when the requested goal is not satisfied; do not invent findings or verified success. Both report outcomes end this execution without a separate acceptance step. Do not repeat commands, re-read targets or write more files. You may join already existing background results if needed; otherwise only submit the report.`;

const reportTools = new Set(["work_finish", "work_read", "read_tool_output", "TaskOutput", "TaskStop", "SendMessage", "TodoRead", "TodoWrite"]);

export function finalReportBoundary(request: (() => boolean) | undefined) {
  let reportingOnly = false;
  const hookRunner: HookRunner = {
    async run(input, options) {
      if (input.hookEventName === "UserPromptSubmit") reportingOnly = false;
      if (input.hookEventName !== "Stop" || input.stopHookActive || options?.signal?.aborted || !request?.())
        return { additionalContexts: [] };
      reportingOnly = true;
      return { stopShouldContinue: true, additionalContexts: [finalReportReminder] };
    },
  };
  return {
    hookRunner,
    allows: (name: string) => !reportingOnly || reportTools.has(name),
    project<T>(request: T): T {
      if (!reportingOnly) return request;
      const value = request as T & { tools?: { name: string }[] };
      return { ...value, ...(value.tools ? { tools: value.tools.filter(tool => reportTools.has(tool.name)) } : {}) };
    },
  };
}
