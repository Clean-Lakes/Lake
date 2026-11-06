import type {
  AICard,
  SessionSnapshot,
  SpecialistChannelEntry,
  SuperWorker,
} from "./contracts";

export const specialistReplyId = (sessionId: string, turnId: string) =>
  JSON.stringify(["reply", sessionId, turnId]);
const prose = (card: AICard) => ["message", "text"].includes(card.type);
const root = (card: AICard): string | undefined => {
  const data = card.data as { root_turn_id?: unknown } | undefined;
  return typeof data?.root_turn_id === "string" ? data.root_turn_id : undefined;
};

/** A display projection only. Original cards, tool receipts and reports stay intact. */
export function specialistReplies(
  entries: SpecialistChannelEntry[],
  sources: {
    snapshot: SessionSnapshot;
    worker: SuperWorker;
    active: boolean;
  }[],
): SpecialistChannelEntry[] {
  const hidden = new Set<string>(),
    replies: SpecialistChannelEntry[] = [];
  for (const { snapshot, worker, active } of sources) {
    const source = snapshot.session.id,
      view = snapshot.ai;
    if (!view) continue;
    const liveId = active ? (view.rootTurnId ?? view.turnStartedAt) : undefined;
    const groups = new Map<
      string,
      { at: string; cards: AICard[]; report?: SpecialistChannelEntry }
    >();
    // SDK root IDs are the boundary; equal content or task names are not.
    for (const card of view.cards) {
      const turn = root(card);
      if (turn && !groups.has(turn))
        groups.set(turn, { at: card.at, cards: [] });
    }
    if (liveId && !groups.has(liveId))
      groups.set(liveId, { at: view.turnStartedAt!, cards: [] });
    const ordered = [...groups].sort((a, b) => a[1].at.localeCompare(b[1].at));
    const atTurn = (at: string) =>
      [...ordered].reverse().find(([, group]) => group.at <= at)?.[0];
    for (const card of view.cards) {
      const turn = root(card) ?? atTurn(card.at),
        group = turn ? groups.get(turn) : undefined;
      if (group) group.cards.push(card);
    }
    for (const entry of entries) {
      const author = entry.message?.author;
      if (
        author?.sessionId === source &&
        author.taskId === worker.task.taskId
      ) {
        const turn = author.rootTurnId ?? atTurn(entry.createdAt),
          group = turn ? groups.get(turn) : undefined;
        if (group) {
          hidden.add(entry.id);
          if (!group.report || group.report.createdAt <= entry.createdAt)
            group.report = entry;
        } else if (author.rootTurnId) {
          // Errors can finish before any prose/card is emitted. Their report still
          // belongs to this exact invocation, never the preceding successful one.
          groups.set(author.rootTurnId, {
            at: entry.createdAt,
            cards: [],
            report: entry,
          });
          hidden.add(entry.id);
        }
      }
      if (
        entry.sourceSessionId === source &&
        ((entry.card && prose(entry.card)) ||
          (entry.message?.role === "assistant" && !entry.message.author))
      ) {
        const turn = entry.card
          ? (root(entry.card) ?? atTurn(entry.createdAt))
          : atTurn(entry.createdAt);
        if (turn && groups.has(turn)) hidden.add(entry.id);
      }
    }
    for (const [turn, group] of groups) {
      const working = active && turn === liveId && !group.report;
      const latest = group.cards
        .filter((card) => prose(card) && !!card.content?.trim())
        .at(-1);
      if (!working && !group.report && !latest) continue;
      const report = group.report;
      // A settled report is frozen by the host. Never replace it with a cached
      // progress sentence, or derive successful acceptance from a card status.
      replies.push({
        id: specialistReplyId(source, turn),
        sourceSessionId: source,
        taskId: worker.task.taskId,
        workerId: worker.id,
        createdAt: group.at,
        reply: { turnId: turn, state: working ? "working" : "settled" },
        ...(report
          ? { message: report.message }
          : latest
            ? { card: latest }
            : {}),
      });
    }
  }
  return [...entries.filter((entry) => !hidden.has(entry.id)), ...replies].sort(
    (a, b) =>
      a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  );
}

export function liveSpecialistReplies(
  active: SessionSnapshot[],
  workers: SuperWorker[],
): SpecialistChannelEntry[] {
  const bySession = new Map(
    workers.map((worker) => [worker.sessionId, worker]),
  );
  return specialistReplies(
    [],
    active.flatMap((snapshot) => {
      const worker = bySession.get(snapshot.session.id);
      // Limit live projection to the current invocation, not accumulated history.
      const view = snapshot.ai,
        start = view?.turnStartedAt;
      if (!worker || !view || !start) return [];
      return [
        {
          worker,
          active: true,
          snapshot: {
            ...snapshot,
            ai: {
              ...view,
              cards: view.cards.filter((card) => card.at >= start),
            },
          },
        },
      ];
    }),
  );
}
