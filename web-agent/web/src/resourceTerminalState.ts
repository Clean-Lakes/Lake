import type { TerminalSession } from "../../shared/contracts";

export type ResourceTerminalContext = { sessionId: string; resourceId: string };
type ConnectionAttempt = { resourceId: string; context?: ResourceTerminalContext };

/** Connections run independently; only the human's latest selection can change the pane. */
export class ResourceTerminalConnections {
  private pending = new Map<string, ConnectionAttempt>();
  private selected: ConnectionAttempt | null = null;

  begin(resourceId: string): { attempt: ConnectionAttempt; started: boolean } {
    const existing = this.pending.get(resourceId);
    const attempt = existing ?? { resourceId };
    this.pending.set(resourceId, attempt);
    this.selected = attempt;
    return { attempt, started: !existing };
  }

  selectTerminal(): void { this.selected = null; }
  isSelected(attempt: ConnectionAttempt): boolean { return this.selected === attempt; }
  resourceIds(): string[] { return [...this.pending.keys()]; }
  finish(attempt: ConnectionAttempt): void {
    if (this.pending.get(attempt.resourceId) === attempt) this.pending.delete(attempt.resourceId);
  }
}

export function onlineTerminalOptions(terminals: TerminalSession[], name: (resourceId: string) => string): {terminal: TerminalSession; label: string; shortLabel: string}[] {
  const seen = new Set<string>();
  const ordinals = new Map<string, number>();
  return terminals.filter(terminal => {
    if (terminal.interactive !== true || terminal.status === "disconnected" || seen.has(terminal.id)) return false;
    seen.add(terminal.id); return true;
  }).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map(terminal => {
    const number = (ordinals.get(terminal.resourceId) ?? 0) + 1;
    ordinals.set(terminal.resourceId, number);
    return {terminal, label: `${name(terminal.resourceId)} · 终端 ${number}`, shortLabel: `终端 ${number}`};
  });
}

export function reusableResourceTerminal(terminals: TerminalSession[], resourceId: string, interactiveOnly = false): TerminalSession | undefined {
  const candidates = terminals.filter(terminal => terminal.resourceId === resourceId && terminal.status !== "disconnected" && (!interactiveOnly || terminal.interactive === true));
  return candidates.sort((a, b) => Number(b.status === "ready") - Number(a.status === "ready") || b.createdAt.localeCompare(a.createdAt))[0];
}

/** Catalog covers all hosts; the active resource response replaces its stale rows. */
export function panelTerminalSessions(catalog: TerminalSession[], conversation: TerminalSession[], live: TerminalSession[], activeResourceId?: string): TerminalSession[] {
  const rows = [...catalog, ...conversation].filter(item => item.resourceId !== activeResourceId);
  return [...new Map([...rows, ...live].map(item => [item.id, item])).values()];
}
