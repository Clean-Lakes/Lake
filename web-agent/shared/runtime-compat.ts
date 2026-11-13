/** Only historical input uses these identifiers. New records use native names. */
export const legacyNativeAgentSource = 'zcode_subagent';
export const legacyNativeControlSource = 'zcode_subagent_control';
export const isNativeAgentSource = (source: unknown) => source === 'native_subagent' || source === 'acp_subagent' || source === legacyNativeAgentSource;
export const isNativeControlSource = (source: unknown) => source === 'native_subagent_control' || source === legacyNativeControlSource;
