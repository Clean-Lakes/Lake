import type { AgentSummary } from "@zcode/shared";
import { buildSubagentMentionMarkdown } from "@/mentions/mentionMarkdown.js";
import { getBuiltInBeaverMessageIds } from "@/lib/builtInBeaverPresentation.js";
import type { MentionItem } from "@/mentions/mentionTypes.js";

type SubagentMentionInput = Pick<
  AgentSummary,
  "id" | "name" | "description" | "path" | "scope" | "source" | "enabled" | "modelSelection"
>;

function getSubagentSourcePriority(agent: SubagentMentionInput): number {
  if (agent.scope === "workspace") {
    return 0;
  }
  if (agent.source === "user") {
    return 1;
  }
  return 2;
}

function getSubagentSourceLabel(
  agent: SubagentMentionInput,
  formatMessage?: (id: string) => string,
): string {
  if (agent.scope === "workspace") {
    return formatMessage?.("settings.subagents.group.workspace") ?? "Workspace Beavers";
  }
  if (agent.source === "plugin") {
    return formatMessage?.("settings.subagents.group.plugin") ?? "Plugin Beavers";
  }
  if (agent.source === "built-in") {
    return formatMessage?.("settings.subagents.group.builtIn") ?? "Built-in Beavers";
  }
  return formatMessage?.("settings.subagents.group.user") ?? "User Beavers";
}

export function mapSubagentsToMentionItemsForTest(
  agents: SubagentMentionInput[],
  formatMessage?: (id: string) => string,
): MentionItem[] {
  const uniqueAgentsByName = new Map<string, SubagentMentionInput>();
  for (const agent of agents) {
    if (!agent.enabled) {
      continue;
    }
    const key = agent.name.trim().toLowerCase();
    if (!key) {
      continue;
    }
    const current = uniqueAgentsByName.get(key);
    if (!current || getSubagentSourcePriority(agent) < getSubagentSourcePriority(current)) {
      uniqueAgentsByName.set(key, agent);
    }
  }

  return [...uniqueAgentsByName.values()].map((agent) => {
    const beaverMessages = getBuiltInBeaverMessageIds(agent.name, agent.scope, agent.source);
    const sourceLabel = getSubagentSourceLabel(agent, formatMessage);
    const displayName = beaverMessages ? formatMessage?.(beaverMessages.name) : undefined;
    const displayDescription = beaverMessages
      ? formatMessage?.(beaverMessages.description)
      : agent.description;
    const model = agent.modelSelection
      ? `${agent.modelSelection.providerId}/${agent.modelSelection.modelId}`
      : undefined;
    return {
      id: `subagent:${agent.id}`,
      category: "subagents",
      label: agent.name,
      ...(displayName ? { displayLabel: displayName } : {}),
      description: displayDescription ? `${sourceLabel} · ${displayDescription}` : sourceLabel,
      value: agent.name,
      markdown: buildSubagentMentionMarkdown(agent.name),
      keywords: [
        agent.name,
        displayName ?? "",
        agent.description,
        displayDescription ?? "",
        agent.scope,
        agent.source,
        sourceLabel,
        model ?? "",
        agent.path,
      ],
      data: {
        path: agent.path,
        scope: agent.scope,
        source: agent.source,
        model,
      },
    } satisfies MentionItem;
  });
}
