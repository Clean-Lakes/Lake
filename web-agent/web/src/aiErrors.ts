/** Translate known internal failures without rewriting user/assistant prose. */
export function displayAiError(message: string): string {
	if (message.trim() === "context deadline exceeded") return "本轮等待超时。已有消息和操作记录已保留；终端命令可能仍在运行，继续前请先核查执行状态。";
	if (message.includes("context compaction:")) {
		if (message.includes("context deadline exceeded")) return "上下文整理超时。历史消息和操作记录已保留；可以在原会话重试压缩，或切换响应更快的模型后继续。";
		if (message.includes("context canceled")) return "已停止整理上下文。历史消息和操作记录已保留，可以在原会话继续。";
		if (/model returned HTTP 404\b/.test(message)) return "上下文整理未完成：模型接口不存在（HTTP 404）。请检查供应商的 API 格式与 Base URL 是否匹配；历史记录已保留，修正后可继续。";
		if (/model returned HTTP 503\b/.test(message)) return "上下文整理未完成：模型渠道暂不可用（HTTP 503），可能没有支持该模型的可用账号。请切换可用模型或渠道，或稍后重试；历史记录已保留。";
		if (/model returned HTTP (401|403)\b/.test(message)) return "上下文整理未完成：模型接口鉴权或权限校验失败。请检查供应商密钥及模型权限；历史记录已保留。";
		if (/model returned HTTP 429\b/.test(message)) return "上下文整理未完成：模型接口限流或额度不足（HTTP 429）。请检查额度或稍后重试；历史记录已保留。";
	}
	if (message.includes("current tool turn exceeds context budget") || message.includes("message exceeds configured context window")) return "本轮上下文超出配置预算，无法继续处理。原始消息和操作记录已保留，请缩小查询范围后继续。";
	if (message.includes("context compaction: summary input exceeds")) return "上下文整理未完成：摘要输入超出配置预算。历史记录已保留，请缩小查询范围后继续。";
  if (message.includes("context compaction:") && message.includes("model output limit reached")) return "上下文整理未完成：摘要超过模型输出上限。历史记录已保留，请重试。";
  if (message.includes("context compaction: empty summary")) return "上下文整理未完成：模型未返回有效摘要。历史记录已保留，请重试。";
  if (message.includes("model output limit reached")) return "模型回复达到单次输出上限，自动重试仍未完成。已有消息和取证记录已保留，可在原会话继续，或提高单次输出上限。";
  return message;
}
