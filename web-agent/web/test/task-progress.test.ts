import assert from "node:assert/strict";
import test from "node:test";
import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import type {AICard, AITodo, SessionSnapshot} from "../../shared/contracts";
import {AITranscript} from "../src/AIPanel";
import {turnTodos} from "../src/TaskProgress";

const at = (second: number) => `2026-10-16T03:00:${String(second).padStart(2, "0")}Z`;
const oldTasks: AITodo[] = ["恢复 Master", "恢复 Worker", "核对日志"].map(content => ({content, status: "completed"}));
const newTasks: AITodo[] = [{content: "核对 FTP 返回原文", status: "completed"}, {content: "检查 FTP 服务日志", status: "in_progress"}];
const write = (id: string, second: number, todos: AITodo[], status = "completed"): AICard => ({id, type: "operation", title: "todo_write", status, at: at(second), data: {arguments: {todos}}, content: JSON.stringify({todos})});
function fixture(cards: AICard[]): SessionSnapshot {
  return {session: {id: "todo-fixture"}, resources: [], messages: [
    {id: "first", role: "user", text: "恢复集群", createdAt: at(0)},
    {id: "second", role: "user", text: "FTP 返回 421 的问题是为啥", createdAt: at(10)},
  ], actions: [], ai: {session: "todo-fixture", status: "running", rootTurnId: "second-turn", startedAt: at(0), turnStartedAt: at(10), cardsOffset: 0, cards, todos: oldTasks}} as SessionSnapshot;
}
function renderedTurns(snapshot: SessionSnapshot): [string, string] {
  const html = renderToStaticMarkup(createElement(AITranscript, {snapshot}));
  const start = html.indexOf('id="conversation-turn-todo-fixture-first"');
  const split = html.indexOf('id="conversation-turn-todo-fixture-second"');
  assert.ok(split > 0);
  return [html.slice(start, split), html.slice(split)];
}

test("old completed tasks stay in their own turn while a new reply is running", () => {
  const [oldTurn, newTurn] = renderedTurns(fixture([write("old", 2, oldTasks)]));
  assert.match(oldTurn, /任务进度 3 \/ 3/);
  assert.ok(!newTurn.includes('class="ai-task-progress"'));
  assert.ok(!newTurn.includes("恢复 Master"));
});

test("each turn uses its own latest successful task update rather than the global list", () => {
  const snapshot = fixture([write("old", 2, oldTasks), write("new-start", 11, newTasks.map(todo => ({...todo, status: "pending"}))), write("new-update", 12, newTasks)]);
  const [oldTurn, newTurn] = renderedTurns(snapshot);
  assert.match(oldTurn, /任务进度 3 \/ 3/);
  assert.match(newTurn, /任务进度 1 \/ 2/);
  assert.ok(!newTurn.includes("恢复 Master"));
  snapshot.ai!.status = "completed";
  assert.match(renderedTurns(snapshot)[1], /任务进度 1 \/ 2/);
});

test("reading previous progress or a failed/pending write does not adopt it for a new turn", () => {
  const read: AICard = {...write("read", 11, oldTasks), title: "todo_read"};
  const [oldTurn, newTurn] = renderedTurns(fixture([write("old", 2, oldTasks), read, write("pending", 12, newTasks, "running"), write("failed", 13, newTasks, "failed")]));
  assert.match(oldTurn, /任务进度 3 \/ 3/);
  assert.ok(!newTurn.includes('class="ai-task-progress"'));
});

test("an explicit empty task list clears only that turn's progress", () => {
  const [oldTurn, newTurn] = renderedTurns(fixture([write("old", 2, oldTasks), write("new", 11, newTasks), write("clear", 12, [])]));
  assert.match(oldTurn, /任务进度 3 \/ 3/);
  assert.ok(!newTurn.includes('class="ai-task-progress"'));
});

test("missing paginated write records never attach global progress to a new question", () => {
  const snapshot = fixture([]);
  snapshot.ai!.cardsOffset = 50;
  snapshot.ai!.cards = [{id: "lookup", type: "operation", title: "list_assets", status: "completed", at: at(11)}];
  assert.ok(!renderToStaticMarkup(createElement(AITranscript, {snapshot})).includes('class="ai-task-progress"'));
});

test("large or legacy result previews use validated successful arguments; invalid data stays hidden", () => {
  assert.deepEqual(turnTodos([{...write("large", 2, newTasks), content: '{"todos": [truncated'}]), newTasks);
  assert.deepEqual(turnTodos([{...write("legacy", 2, newTasks), data: undefined}]), newTasks);
  assert.deepEqual(turnTodos([{...write("invalid", 2, newTasks), content: "null", data: {arguments: {todos: [{content: "x", status: "invented"}]}}}]), []);
});
