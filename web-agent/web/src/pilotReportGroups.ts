import type {Message, SpecialistReplyAuthor} from '../../shared/contracts';

/** Keep old aggregate receipts if any original specialist answer is missing. */
export function redundantJointReports(messages: readonly Message[]) {
  const originals = new Map<string, Message[]>();
  for (const message of messages) {
    const taskId = message.author?.taskId;
    if (message.role !== 'assistant' || !taskId || !message.replyToMessageId) continue;
    const reports = originals.get(taskId) ?? [];
    reports.push(message);
    originals.set(taskId, reports);
  }
  const redundant = new Set<string>();
  for (const message of messages) {
    if (!message.jointReport || message.images?.length || message.files?.length) continue;
    const header = message.text.split('\n\n', 1)[0];
    const expected = Number(header?.match(/」的 (\d+) 位专员均已提交报告。$/u)?.[1]);
    if (!(expected >= 2)) continue;
    const copies = originals.get(message.jointReport.taskId)?.filter(report =>
      report.sessionId === message.sessionId && report.text.trim() && message.text.includes(report.text.trim()));
    if (copies && new Set(copies.map(report => report.replyToMessageId)).size === 1 &&
        new Set(copies.map(report => report.author!.workerId)).size === expected) redundant.add(message.id);
  }
  return redundant;
}

export function pilotReportParticipants(authors: readonly SpecialistReplyAuthor[]) {
  return [...new Map(authors.map(author => {
    const key = author.roleId || author.workerId;
    return [key, {key, roleId: author.roleId, name: author.name, moving: false}];
  })).values()];
}
