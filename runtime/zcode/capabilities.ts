import type { ToolEntry } from "@zcode/core";

let builtInTools: readonly ToolEntry[] = [];
export function connectAgentToolCatalog(tools: readonly ToolEntry[]) {
  builtInTools = Object.freeze([...tools]);
}

// One tool surface for Pilot, independent Workers and their native children.
// Product services are enabled by their real host ports, never by role names.
export const generalAgentTools = [
  "ToolSearch",
  "DeferredToolCall",
  "Read",
  "Write",
  "Edit",
  "Bash",
  "FindFiles",
  "SearchText",
  "WebFetch",
  "WebSearch",
  "TodoRead",
  "TodoWrite",
];
export const interactionAgentTools = [
  "AskUserQuestion",
  "EnterPlanMode",
  "ExitPlanMode",
  "Skill",
];
export const nativeAgentControls = [
  "Agent",
  "Task",
  "TaskOutput",
  "TaskStop",
  "SendMessage",
];
export const agentToolNames = [...generalAgentTools, ...interactionAgentTools];
export const nativeTool = (name: string): ToolEntry => {
  const entry = builtInTools.find((tool) => tool.metadata.name === name);
  if (!entry) throw new Error("Pinned ZCode tool is missing: " + name);
  return entry;
};
export function agentCapabilityCatalog(
  ports: { nativeWebSearch?: boolean } = {},
) {
  const active = new Set([
    ...agentToolNames,
    ...nativeAgentControls,
    "Glob",
    "Grep",
  ]);
  return builtInTools.map((tool) => ({
    name: tool.metadata.name,
    ...(["Glob", "Grep"].includes(tool.metadata.name)
      ? {
          exposedAs: tool.metadata.name === "Glob" ? "FindFiles" : "SearchText",
        }
      : {}),
    status:
      tool.metadata.name === "WebSearch" && !ports.nativeWebSearch
        ? "model_dependent"
        : active.has(tool.metadata.name)
          ? "connected"
          : "requires_host_service",
    ...(active.has(tool.metadata.name) &&
    !(tool.metadata.name === "WebSearch" && !ports.nativeWebSearch)
      ? {}
      : {
          reason:
            tool.metadata.name === "WebSearch"
              ? "requires a provider with native search"
              : tool.metadata.name === "ReadSessionContext"
                ? "requires a task-scoped archive reader"
                : tool.metadata.name === "js"
                  ? "requires an installed browser bridge/plugin"
                  : "requires the corresponding workflow, automation or coordinator port",
        }),
  }));
}

export const nativeSearchSupported = (
  protocol: string | undefined,
  enabled: boolean | undefined,
) => ["anthropic", "claude"].includes(protocol ?? "") && enabled === true;
