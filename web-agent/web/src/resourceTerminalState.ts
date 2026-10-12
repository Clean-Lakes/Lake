import type { TerminalSession } from "../../shared/contracts";

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
