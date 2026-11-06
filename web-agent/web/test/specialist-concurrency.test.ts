import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { SuperWorker, SuperWorkspace } from "../../shared/contracts";
import {
  specialistTaskActivity,
  stopControlPresentation,
} from "../src/superAgentPresentation";
import { PilotWorkspace } from "../src/PilotWorkspace";
import { SuperTaskInspector } from "../src/SuperTaskInspector";

const worker = (
  id: string,
  state: SuperWorker["task"]["state"] = "running",
  updatedAt = "2026-11-06T08:00:00Z",
): SuperWorker => ({
  id,
  roleId: "role",
  roleName: "并发专员",
  sessionId: "session-" + id,
  assignmentState: state === "running" ? "active" : "parked",
  createdAt: "2026-11-06T07:00:00Z",
  task: {
    taskId: id,
    sessionId: "session-" + id,
    title: "任务 " + id,
    state,
    acceptanceState: "not_evaluated",
    revision: 1,
    originRootTurnId: id,
    deadlineAt: "2026-11-07T00:00:00Z",
    updatedAt,
  },
});
const render = (workers: SuperWorker[]) =>
  renderToStaticMarkup(
    createElement(PilotWorkspace, {
      workspace: {
        active: true,
        project: { projectId: "project", routerSessionId: "pilot", version: 1 },
        channels: [
          {
            id: "channel",
            projectId: "project",
            roleId: "role",
            roleName: "并发专员",
            sessionId: "channel",
            revision: 1,
            createdAt: "",
            running: workers.some((w) => w.assignmentState === "active"),
          },
        ],
        workers,
      } as SuperWorkspace,
      error: "",
      selectedId: "channel",
      onPilot() {},
      onWorker() {},
    }),
  );

test("one role displays two actual running tasks and retains a single navigation entry", () => {
  const html = render([worker("A"), worker("B")]);
  assert.match(html, /2 项执行中/);
  assert.match(html, /aria-label="2 项任务执行中"/);
  assert.equal(
    (html.match(/class="nav-row pilot-worker-row/g) ?? []).length,
    1,
  );
  assert.equal(
    specialistTaskActivity([worker("A"), worker("B")]).runningCount,
    2,
  );
});
test("stopping A leaves the sidebar bound to the actually active task B", () => {
  const html = render([
    worker("A", "cancelled", "2026-11-06T09:00:00Z"),
    worker("B"),
  ]);
  assert.match(html, /任务 B/);
  assert.doesNotMatch(html, /任务 A|pilot-worker-count/);
  assert.match(html, /aria-label="执行中"/);
});
test("an idle specialist shows the most recently updated task rather than the newest-created or first task", () => {
  const a = worker("A", "cancelled", "2026-11-06T08:00:00Z"),
    b = worker("B", "completed", "2026-11-06T09:00:00Z");
  a.createdAt = "2026-11-06T07:30:00Z";
  b.task.acceptanceState = "pass";
  const html = render([a, b]);
  assert.match(html, /任务 B/);
  assert.match(html, /已验收/);
  assert.doesNotMatch(html, /任务 A|pilot-worker-running/);
});
test("queued and actual waiting tasks remain distinct and old parked waiting states do not count", () => {
  const active = worker("A"),
    queued = { ...worker("B"), assignmentState: "queued" },
    waiting = {
      ...worker("C"),
      activity: {
        phase: "waiting_input" as const,
        label: "补充信息",
        updatedAt: "",
      },
    },
    old = worker("D", "waiting_user");
  const status = specialistTaskActivity([old, waiting, queued, active]);
  assert.equal(status.runningCount, 1);
  assert.equal(status.waitingCount, 1);
  assert.equal(status.queuedCount, 1);
  assert.equal(status.detail, "1 项执行中 · 1 项待确认 · 1 项排队");
});
test("project, specialist, single-task and reply stop controls have explicit independent scopes", () => {
  assert.equal(
    stopControlPresentation("router", true).label,
    "停止当前项目全部任务",
  );
  assert.equal(
    stopControlPresentation("role", true).label,
    "停止该专员全部任务",
  );
  assert.equal(stopControlPresentation("worker", true).label, "停止当前任务");
  assert.equal(stopControlPresentation("router", false).label, "停止本轮回复");
  const task = worker("A").task;
  const html = renderToStaticMarkup(
    createElement(SuperTaskInspector, {
      task,
      goal: { id: "A", items: [], modelRounds: 1, roundLimit: 500 } as any,
      connected: true,
    }),
  );
  assert.match(html, /仅停止此任务/);
  assert.match(html, /不影响该专员的其他任务/);
  assert.match(html, /aria-label="停止任务：任务 A"/);
});
