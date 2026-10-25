import type {SessionSnapshot, TerminalEntry, TerminalHistory} from '../../shared/contracts';

// The observer only reads terminals already exposed by this session's access
// checks. Names, command text and the catalog are never used to infer access.
export function sshExecutionScope(snapshot: SessionSnapshot | null) {
  const startedAt = snapshot?.ai?.turnStartedAt;
  if (!snapshot || !startedAt || !Number.isFinite(Date.parse(startedAt))) return null;
  const latestUser = snapshot.messages?.filter(message => message.role === 'user').at(-1);
  if (latestUser && Date.parse(latestUser.createdAt) > Date.parse(startedAt)) return null;
  const ssh = new Set(snapshot.resources.filter(resource => resource.kind === 'ssh').map(resource => resource.id));
  return {
    key: `${snapshot.session.id}:${startedAt}`, session: snapshot.session.id, startedAt,
    running: ['running', 'waiting_approval'].includes(snapshot.ai?.status ?? ''),
    terminals: (snapshot.terminals ?? []).filter(terminal => ssh.has(terminal.resourceId)),
  };
}

export function executionEntries(history: TerminalHistory, session: string, startedAt: string): TerminalEntry[] {
  return history.entries.filter(entry => entry.actor === 'agent' && entry.originSessionId === session
    && entry.terminalId === history.terminal.id && entry.generation === history.terminal.generation
    && Date.parse(entry.startedAt ?? entry.createdAt) >= Date.parse(startedAt));
}

export function latestExecution(histories: TerminalHistory[]) {
  return histories.reduce<TerminalHistory | undefined>((latest, history) => {
    const last = history.entries.at(-1), previous = latest?.entries.at(-1);
    return last && (!previous || Date.parse(last.startedAt ?? last.createdAt) > Date.parse(previous.startedAt ?? previous.createdAt)) ? history : latest;
  }, undefined);
}

export function executionOutput(entries: TerminalEntry[]) {
  // No synthetic trailing newline: the next output chunk must remain an exact
  // prefix extension so xterm appends without clearing or moving the viewport.
  return entries.map(entry => `$ ${entry.command}\r\n${entry.output}`).join('\r\n\r\n');
}

export function executionIsActive(history: TerminalHistory | undefined, status: string | undefined, connected: boolean) {
  return connected && status === 'running' && history?.terminal.status === 'busy'
    && history.terminal.holder === 'agent' && history.entries.at(-1)?.status === 'running';
}
