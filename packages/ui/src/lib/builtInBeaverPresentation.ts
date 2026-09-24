/** 内置角色仅换展示语义；RPC、覆盖配置和会话继续使用原始 agent ID。 */
export function getBuiltInBeaverMessageIds(name: string, scope: string, source: string) {
  if (scope !== "built-in" && source !== "built-in") return null;
  if (name === "general-purpose") {
    return {
      name: "settings.subagents.builtin.generalPurpose.name",
      description: "settings.subagents.builtin.generalPurpose.description",
    } as const;
  }
  if (name === "Explore") {
    return {
      name: "settings.subagents.builtin.explore.name",
      description: "settings.subagents.builtin.explore.description",
    } as const;
  }
  if (name === "lake-sre") {
    return {
      name: "settings.subagents.builtin.sre.name",
      description: "settings.subagents.builtin.sre.description",
    } as const;
  }
  return null;
}
