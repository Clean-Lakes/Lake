import { permissionDefaults } from '../../web-agent/shared/execution-preferences';
import type { PermissionRuleset } from './sdk';

type AutomaticOperation = Extract<keyof typeof permissionDefaults, `silent${string}`>;

// The SDK's build-mode risk/side-effect fallback must not introduce a second
// confirmation authority after the user selected automatic operation in Pilot.
const toolCategories: Partial<Record<AutomaticOperation, readonly string[]>> = {
  silentReadFiles: ['Read', 'Glob', 'Grep', 'FindFiles', 'SearchText', 'list_project_files', 'Skill', 'load_skill', 'WebFetch'],
  silentWriteFiles: ['Write', 'Edit'],
  silentReadSQL: ['list_db_objects', 'db_table_ddl', 'read_db_table'],
  silentCommands: ['Bash', 'inspect_host'],
  silentMCPCalls: ['list_mcp_tools', 'call_mcp_tool'],
};

export function operationApproval(options: Record<string, unknown>, category: AutomaticOperation) {
  const needsApproval = (options[category] ?? permissionDefaults[category]) !== true;
  // Explicit undefined clears an inherited tool-level alwaysAsk. When the
  // switch is off, alwaysAsk prevents readonly/mode/session shortcuts bypassing it.
  return { needsApproval, permission: { needsApproval, alwaysAsk: needsApproval ? true as const : undefined } };
}

export function operationPermissionRules(options: Record<string, unknown>): PermissionRuleset {
  const allow: { toolName: string }[] = [], ask: { toolName: string }[] = [];
  for (const [category, tools] of Object.entries(toolCategories)) {
    const rules = operationApproval(options, category as AutomaticOperation).needsApproval ? ask : allow;
    rules.push(...tools.map(toolName => ({ toolName })));
  }
  return { scope: 'session', version: 1, allow, ask };
}

export function effectiveExecutionPreferences(options: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(permissionDefaults).map(([key, fallback]) => [key, options[key] ?? fallback]));
}
