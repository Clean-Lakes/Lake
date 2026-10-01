// ============================================================
// CLI Prefix Section Builder
// ============================================================

import type { ContextSection, ContextBuilderConfig } from "../types.js";
import { estimateTokens } from "../utils.js";

const CLI_PREFIX_PROMPT = "You are ZCode, an interactive coding agent";

export function buildCliPrefixSection(
  identity?: ContextBuilderConfig["productIdentity"],
): ContextSection {
  const content = identity
    ? `You are ${identity.name}, an interactive coding and operations agent`
    : CLI_PREFIX_PROMPT;

  return {
    name: "CLI Prefix",
    source: "cli_prefix",
    injectionTarget: "system",
    cacheHint: "stable",
    chars: content.length,
    tokens: estimateTokens(content),
    content,
    preview: content.slice(0, 100),
  };
}
