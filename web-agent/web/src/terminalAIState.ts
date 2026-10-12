export type TerminalBinding = { sessionId: string; terminalId: string; generation: string };
export const sameTerminalBinding = (a: TerminalBinding, b: TerminalBinding) => a.sessionId === b.sessionId && a.terminalId === b.terminalId && a.generation === b.generation;
export const terminalTurnActive = (status?: string) => status === "running" || status === "waiting_approval";

export const uniqueTerminalRows = <T extends {id:string}>(rows:T[]):T[] => [...new Map(rows.map(row=>[row.id,row])).values()];
