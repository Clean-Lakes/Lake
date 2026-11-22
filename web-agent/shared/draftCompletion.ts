export const draftCompletionLimit = 2000;

const credentialText = /-----BEGIN|(?:\b(?:api[_ -]?key|access[_ -]?token|password|secret|token|private[_ -]?key)|密码|口令|密钥|访问令牌)["']?\s*[:=：]|\bbearer\s+\S+|\b(?:sk-|gh[pousr]_|github_pat_|xox[baprs]-)[\w-]{8,}|https?:\/\/[^/\s:@]+:[^/\s@]+@|\[(?:PRIVATE KEY )?REDACTED\]/i;

export function completableDraft(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length > 0 && Array.from(text).length <= draftCompletionLimit &&
    !/[。！？.!?]\s*$|\n[ \t]*$/.test(text) && !trimmed.startsWith('/') &&
    !/[\x00@\ufffc]|```/.test(text) && !credentialText.test(text);
}

export function completionSuffix(value: unknown): value is string {
  return typeof value === 'string' && !!value.trim() && Array.from(value).length <= 120 &&
    !/[\x00-\x1f@\ufffc]|```/.test(value) && !credentialText.test(value);
}
