import type { SessionSnapshot, WorkSession } from "../../shared/contracts";

export type StreamState = "connecting" | "connected" | "polling" | "disconnected";

// A background process has its own terminal lifecycle. It must not turn a
// completed conversation's Send button back into Stop.
export function conversationActive(snapshot: SessionSnapshot | null, status?: WorkSession["status"]): boolean {
  return !!snapshot?.hostKeyTrust || !!snapshot?.ai && (["running", "waiting_approval"].includes(snapshot.ai.status) || status === "investigating");
}

export function sessionConnection(state: {
  ready: boolean;
  sessionId: string | null;
  streamSessionId: string | null;
  streamState: StreamState;
  snapshotReady: boolean;
  restoring: boolean;
  error: string;
}) {
  const current = !!state.sessionId && state.sessionId === state.streamSessionId;
  return {
    connected: state.ready && (!state.sessionId || current && state.snapshotReady &&
      ["connected", "polling"].includes(state.streamState) && !state.restoring && !state.error),
    warning: state.ready && current && (!!state.error || state.streamState === "disconnected"),
  };
}
