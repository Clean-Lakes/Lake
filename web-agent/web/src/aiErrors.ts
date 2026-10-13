/** Translate known internal failures without rewriting user/assistant prose. */
export function displayAiError(message: string): string {
	if (message.includes("current tool turn exceeds context budget") || message.includes("message exceeds configured context window")) return "本轮上下文超出配置预算，无法继续处理。原始消息和操作记录已保留，请缩小查询范围后继续。";
	if (message.includes("context compaction: summary input exceeds")) return "上下文整理未完成：摘要输入超出配置预算。历史记录已保留，请缩小查询范围后继续。";
  if (message.includes("context compaction:") && message.includes("model output limit reached")) return "上下文整理未完成：摘要超过模型输出上限。历史记录已保留，请重试。";
  if (message.includes("context compaction: empty summary")) return "上下文整理未完成：模型未返回有效摘要。历史记录已保留，请重试。";
  return message;
}
