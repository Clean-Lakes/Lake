import { useMemo } from "react";
import { BeaverIcon } from "@/components/icons/BeaverIcon.js";
import type { IntlInstance } from "@/i18n/IntlProvider.js";
import type { PromptInputSuggestionItem } from "@/lib/promptInputTriggers.js";
import {
  type MentionPanelOption,
  type MentionPanelSection,
} from "@/mentions/components/MentionPanel.js";

export function useSlashCommandMentionPanelSections(
  intl: IntlInstance,
  commandsLength: number,
  filteredCommandSuggestions: PromptInputSuggestionItem[],
  filteredSkillSuggestions: PromptInputSuggestionItem[],
  skillsLoading: boolean,
  skillsError: string | null,
  filteredSubagentSuggestions: PromptInputSuggestionItem[],
  subagentsLoading: boolean,
  subagentsError: string | null,
): MentionPanelSection[] {
  return useMemo(
    () => [
      {
        id: "commands",
        title: intl.formatMessage({ id: "chat.slash.commands.title" }),
        options: filteredCommandSuggestions.map<MentionPanelOption>((suggestion) => ({
          id: suggestion.id,
          label: `/${suggestion.value}`,
          description: suggestion.description,
          content: (
            <span className="min-w-0 flex-1 flex items-center gap-2">
              <span className="truncate text-ui-base font-medium text-foreground max-w-[40%]">
                {`/${suggestion.value}`}
              </span>
              <span className="truncate text-ui-base text-foreground-subtlest flex-1">
                {suggestion.description}
              </span>
            </span>
          ),
        })),
        loading: false,
        emptyText:
          commandsLength === 0
            ? intl.formatMessage({ id: "chat.slash.emptyUnavailable" })
            : intl.formatMessage({ id: "chat.slash.emptyResults" }),
      },
      {
        id: "skills",
        title: intl.formatMessage({ id: "chat.slash.skills.title" }),
        options: filteredSkillSuggestions.map<MentionPanelOption>((suggestion) => ({
          id: suggestion.id,
          label: `$${suggestion.value}`,
          description: suggestion.description,
          content: (
            <span className="min-w-0 flex-1 flex items-center gap-2">
              <span className="truncate text-ui-base font-medium text-foreground max-w-[40%]">
                {`$${suggestion.value}`}
              </span>
              <span className="truncate text-ui-base text-foreground-subtlest flex-1">
                {suggestion.description}
              </span>
            </span>
          ),
        })),
        loading: skillsLoading,
        loadingText: intl.formatMessage({ id: "chat.mention.category.loading" }),
        emptyText: intl.formatMessage({ id: "chat.slash.skills.empty" }),
        errorText: skillsError,
      },
      {
        id: "subagents",
        title: intl.formatMessage({ id: "chat.slash.subagents.title" }),
        options: filteredSubagentSuggestions.map<MentionPanelOption>((suggestion) => {
          return {
            id: suggestion.id,
            // 旧面板把运行时 value 当展示名，导致内置河狸仍显示 general-purpose / Explore。
            // 展示和无障碍名称使用本地化 label；插入与调用继续由原 value 负责。
            label: suggestion.label,
            description: suggestion.description,
            content: (
              <span className="min-w-0 flex-1 flex items-center gap-2">
                <BeaverIcon className="size-5 shrink-0 text-foreground" />
                <span className="truncate text-ui-base font-medium text-foreground max-w-[40%]">
                  {suggestion.label}
                </span>
                <span className="truncate text-ui-base text-foreground-subtlest flex-1">
                  {suggestion.description}
                </span>
              </span>
            ),
          };
        }),
        loading: subagentsLoading,
        emptyText: intl.formatMessage({ id: "chat.slash.subagents.empty" }),
        errorText: subagentsError,
      },
    ],
    [
      commandsLength,
      filteredCommandSuggestions,
      filteredSkillSuggestions,
      filteredSubagentSuggestions,
      intl,
      skillsError,
      skillsLoading,
      subagentsError,
      subagentsLoading,
    ],
  );
}
