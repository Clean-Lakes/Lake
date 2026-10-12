/** Translate known internal failures without rewriting user/assistant prose. */
export function displayAiError(message: string): string {
  if (message.includes("context compaction:") && message.includes("model output limit reached")) return "上下文整理未完成：摘要超过模型输出上限。历史记录已保留，请重试。";
  if (message.includes("context compaction: empty summary")) return "上下文整理未完成：模型未返回有效摘要。历史记录已保留，请重试。";
  return message;
}
