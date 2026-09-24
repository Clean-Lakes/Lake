// ============================================================
// CLI Prefix Section Builder
// ============================================================

import type { ContextSection } from "../types.js";
import { estimateTokens } from "../utils.js";

// 旧前缀把所有使用它的会话都指定为 ZCode 主智能体；产品上下文不能覆盖子智能体或自定义身份。
const CLI_PREFIX_PROMPT =
  "This session runs in Lake, the software operations and SRE product by Clean-Lakes.";

export function buildCliPrefixSection(): ContextSection {
  const content = CLI_PREFIX_PROMPT;

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
