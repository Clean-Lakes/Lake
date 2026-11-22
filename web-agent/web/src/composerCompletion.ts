const starters = [
  '帮我检查服务运行状态。',
  '帮我查看 CPU、内存和磁盘使用情况。',
  '请分析这段日志，找出错误原因和排查步骤。',
  '请对照上次结果，看看现在有没有变化。',
];

export const composerCompletionStorageKey = 'lake.composer-completion';
export const emptyCompletionDelay = 140;
export const draftCompletionDelay = 650;

export function localComposerCompletion(draft: string, hasPreviousReply: boolean): string {
  if (!draft) return starters[hasPreviousReply ? 3 : 0]!;
  if (hasPreviousReply && /^(?:真的[吗么]|你?确定吗|是这样吗)[？?]+$/.test(draft.trim())) {
    return `${draft.endsWith('?') ? ' ' : ''}可以说一下判断依据吗？`;
  }
  const prefix = draft.toLocaleLowerCase();
  const match = starters.find(text => text.length > draft.length && text.toLocaleLowerCase().startsWith(prefix));
  return match?.slice(draft.length) ?? '';
}
