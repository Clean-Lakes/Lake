import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type {
  AICard,
  SessionSnapshot,
  SpecialistChannelEntry,
  SuperWorker,
} from "../../shared/contracts";
import {
  specialistReplies,
  specialistReplyId,
} from "../../shared/specialist-replies";
import {
  mergeChannelPage,
  mergeChannelEntries,
} from "../src/specialistChannelProjection";
import {
  SpecialistChannelEntries,
  SpecialistLiveReply,
} from "../src/SpecialistChannel";

const at = "2026-11-06T08:00:00Z";
const worker: SuperWorker = {
  id: "worker",
  roleId: "role",
  roleName: "数据库专员",
  sessionId: "source",
  assignmentState: "active",
  task: {
    taskId: "task",
    sessionId: "source",
    title: "对比两端数据库",
    state: "running",
    acceptanceState: "not_evaluated",
    revision: 1,
    originRootTurnId: "origin",
    deadlineAt: "",
  },
};
const card = (
  id: string,
  content: string,
  type = "message",
  turn = "turn-a",
  time = at,
): AICard => ({
  id,
  at: time,
  type,
  content,
  status: "completed",
  data: { root_turn_id: turn, taskId: "task" },
});
const snapshot = (
  cards: AICard[],
  status = "running",
  turn = "turn-a",
): SessionSnapshot =>
  ({
    session: { id: "source" },
    messages: [],
    resources: [],
    actions: [],
    ai: {
      session: "source",
      status,
      rootTurnId: turn,
      turnStartedAt: at,
      cards,
    },
  }) as SessionSnapshot;
const raw = (cards: AICard[]): SpecialistChannelEntry[] =>
  cards
    .filter((c) => c.type === "message")
    .map((c) => ({
      id: c.id,
      createdAt: c.at,
      sourceSessionId: "source",
      taskId: "task",
      card: c,
    }));
const report = (
  text: string,
  turn = "turn-a",
  time = "2026-11-06T08:01:00Z",
): SpecialistChannelEntry => ({
  id: "report-" + turn,
  sourceSessionId: "channel",
  createdAt: time,
  message: {
    id: "report-" + turn,
    sessionId: "channel",
    role: "assistant",
    text,
    createdAt: time,
    author: {
      kind: "specialist",
      name: "数据库专员",
      workerId: "worker",
      sessionId: "source",
      taskId: "task",
      rootTurnId: turn,
    },
  },
});
const render = (entries: SpecialistChannelEntry[], s?: SessionSnapshot) =>
  renderToStaticMarkup(
    createElement(SpecialistChannelEntries, {
      entries,
      resources: [],
      workers: [worker],
      activeSnapshots: new Map(s ? [["source", s]] : []),
    }),
  );

test("one SDK invocation replaces progress in place and the final host report replaces all narration", () => {
  const first = card("first", "正在连接两端数据库"),
    second = card("second", "已取得库表清单，正在核对差异");
  const s = snapshot([
    first,
    card("tool", "RAW_TOOL_RECEIPT", "operation"),
    second,
  ]);
  const original = JSON.stringify(s);
  const working = specialistReplies(raw(s.ai!.cards), [
    { snapshot: s, worker, active: true },
  ]);
  assert.equal(working.length, 1);
  assert.equal(working[0].id, specialistReplyId("source", "turn-a"));
  assert.equal(working[0].card?.id, "second");
  const html = render(working, s);
  assert.match(html, /已取得库表清单/);
  assert.doesNotMatch(html, /正在连接两端|RAW_TOOL_RECEIPT/);
  assert.match(html, /status-text--active/);
  const ended = specialistReplies(
    [
      ...raw(s.ai!.cards),
      report("已核对两端：库名和表数一致，复制延迟 0 秒。"),
    ],
    [
      {
        snapshot: { ...s, ai: { ...s.ai!, status: "completed" } },
        worker,
        active: false,
      },
    ],
  );
  assert.equal(ended.length, 1);
  assert.equal(ended[0].id, working[0].id);
  assert.equal(ended[0].reply?.state, "settled");
  assert.equal(ended[0].message?.author?.taskId, "task");
  assert.match(render(ended), /已核对两端/);
  assert.doesNotMatch(render(ended), /正在核对差异|status-text--active/);
  assert.equal(
    JSON.stringify(s),
    original,
    "projection never rewrites canonical source cards",
  );
});

test("polling, history pages and late live snapshots cannot restore narration after a final report", () => {
  const s = snapshot([card("first", "先检查连接")]);
  const live = mergeChannelPage([], {
    replyPresentation: "invocation",
    entries: [],
    active: [s],
    workers: [worker],
  });
  const newer = snapshot([
    ...s.ai!.cards,
    { ...card("next", "下一步正在生成"), status: "running" },
  ]);
  const updated = mergeChannelPage(live, {
    replyPresentation: "invocation",
    entries: [],
    active: [newer],
    workers: [worker],
  });
  assert.equal(updated.length, 1);
  assert.equal(
    updated[0].card?.id,
    "next",
    "a new running card replaces preceding completed progress in the same slot",
  );
  const end = specialistReplies(
    [...raw(s.ai!.cards), report("最终结果")],
    [{ snapshot: s, worker, active: false }],
  );
  const merged = mergeChannelPage(live, {
    replyPresentation: "invocation",
    entries: end,
    active: [],
    workers: [worker],
  });
  const late = mergeChannelPage(merged, {
    replyPresentation: "invocation",
    entries: [],
    active: [s],
    workers: [worker],
  });
  assert.equal(late.length, 1);
  assert.equal(late[0].message?.text, "最终结果");
  assert.deepEqual(mergeChannelEntries(late, end), late);
  assert.deepEqual(
    mergeChannelPage(late, {
      replyPresentation: "invocation",
      entries: live,
      active: [s],
      workers: [worker],
    }),
    late,
    "a late complete page cannot downgrade a frozen report",
  );
});

test("failed resume has its own summary and never republishes the preceding invocation answer", () => {
  const old = card("old", "上一次检查结果"),
    s = snapshot([old], "failed", "turn-b");
  const result = specialistReplies(
    [
      ...raw([old]),
      report("上一次检查结果"),
      report("本次连接中断，尚未完成。", "turn-b", "2026-11-06T09:01:00Z"),
    ],
    [{ snapshot: s, worker, active: false }],
  );
  assert.equal(result.length, 2);
  assert.notEqual(result[0].id, result[1].id);
  assert.equal(result[1].message?.text, "本次连接中断，尚未完成。");
  assert.doesNotMatch(result[1].message?.text ?? "", /上一次/);
});

test("equal text in independent tasks remains distinct and keeps task dividers and user input", () => {
  const a = snapshot([card("same", "正在检查")]),
    other = {
      ...worker,
      id: "other",
      sessionId: "other",
      task: { ...worker.task, taskId: "other-task", sessionId: "other" },
    };
  const b = { ...a, session: { ...a.session, id: "other" } };
  const user: SpecialistChannelEntry = {
    id: "user",
    sourceSessionId: "channel",
    createdAt: "2026-11-06T07:59:00Z",
    message: {
      id: "user",
      sessionId: "channel",
      role: "user",
      text: "保留我直接发送的补充",
      createdAt: at,
    },
  };
  const entries = specialistReplies(
    [user],
    [
      { snapshot: a, worker, active: true },
      { snapshot: b, worker: other, active: true },
    ],
  );
  assert.equal(new Set(entries.map((e) => e.id)).size, 3);
  const html = renderToStaticMarkup(
    createElement(SpecialistChannelEntries, {
      entries,
      resources: [],
      workers: [worker, other],
      activeSnapshots: new Map([
        ["source", a],
        ["other", b],
      ]),
    }),
  );
  assert.equal((html.match(/role="separator"/g) ?? []).length, 2);
  assert.match(html, /保留我直接发送的补充/);
});

test("waiting, disconnected and inactive replies stop animation while actual model work remains animated", () => {
  const s = snapshot([]),
    waiting = { ...s, ai: { ...s.ai!, status: "waiting_approval" } };
  const draw = (connected: boolean, snap: SessionSnapshot) =>
    renderToStaticMarkup(
      createElement(SpecialistLiveReply, {
        snapshot: snap,
        worker,
        text: "正在读取数据",
        connected,
      }),
    );
  assert.match(draw(true, s), /status-text--active/);
  for (const html of [
    draw(false, s),
    draw(true, waiting),
    draw(true, { ...s, ai: { ...s.ai!, status: "completed" } }),
  ])
    assert.doesNotMatch(html, /status-text--active|reply-duration-spinner/);
  assert.match(draw(true, waiting), /等待确认/);
  assert.match(draw(false, s), /正在重连/);
});

test("historical root metadata compacts narration without deleting unbound legacy records or plans", () => {
  const cards = [
    card("progress", "OLD_PROGRESS"),
    card("tool", "receipt", "operation"),
    card("final", "<proposed_plan>\n1. PLAN_PRIVATE_STEP\n</proposed_plan>"),
  ];
  const s = snapshot(cards, "completed");
  const legacy = {
    ...report("LEGACY_UNBOUND"),
    id: "legacy",
    message: {
      ...report("LEGACY_UNBOUND").message!,
      author: undefined,
      sessionId: "legacy",
    },
  };
  const entries = specialistReplies(
    [...raw(cards), legacy],
    [{ snapshot: s, worker, active: false }],
  );
  const html = render(entries);
  assert.doesNotMatch(html, /OLD_PROGRESS|PLAN_PRIVATE_STEP/);
  assert.match(html, /计划已保存/);
  assert.match(html, /LEGACY_UNBOUND/);
});

test("hosts without invocation presentation retain source-card compatibility even when they have root IDs", () => {
  const s = snapshot([card("a", "进展一"), card("b", "进展二")]);
  const legacy = mergeChannelPage([], {
    entries: [],
    active: [s],
    workers: [worker],
  });
  assert.equal(legacy.length, 2);
  assert.ok(legacy.every((entry) => !entry.reply));
  const modern = mergeChannelPage([], {
    replyPresentation: "invocation",
    entries: [],
    active: [s],
    workers: [worker],
  });
  assert.equal(modern.length, 1);
  assert.equal(modern[0].card?.content, "进展二");
});

test("SDK initialization without a root ID cannot leave an orphaned thinking reply after the first real event", () => {
  const s = snapshot([]);
  delete s.ai!.rootTurnId;
  const initial = mergeChannelPage([], {
    replyPresentation: "invocation",
    entries: [],
    active: [s],
    workers: [worker],
  });
  assert.equal(initial.length, 0);
  const running = mergeChannelPage(initial, {
    replyPresentation: "invocation",
    entries: [],
    active: [snapshot([card("a", "实际执行进展")])],
    workers: [worker],
  });
  assert.equal(running.length, 1);
  assert.equal(running[0].reply?.turnId, "turn-a");
});
