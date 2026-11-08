import assert from "node:assert/strict";
import test from "node:test";
import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import type {AICard, AITodo, SessionSnapshot} from "../../shared/contracts";
import {AITranscript} from "../src/AIPanel";
import {TaskProgress,turnTodos} from "../src/TaskProgress";
import {progressGlyph,toolDescription} from "../src/activity";
import {conversationGroups} from "../src/conversation-progress-model";

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

test("native task receipts survive a cold paused snapshot and show the checklist from precisely the selected execution", () => {
  const native = (taskId:string, id:string, todos:AITodo[]):AICard => ({
    ...write(id,12,todos),title:"TodoWrite",
    data:{root_turn_id:"turn-second",taskId,call_id:id,arguments:{todos}},
    content:JSON.stringify({oldTodos:[],todos,success:true}),
  });
  const own=native("execution-A","write-A",newTasks), other=native("execution-B","write-B",oldTasks);
  const child={...other,data:{...(other.data as object),taskId:"execution-A",agentRunId:"subagent"}};
  const unbound=write("legacy",14,oldTasks);
  const cards=JSON.parse(JSON.stringify([own,other,child,unbound,
    {...other,title:"TodoRead"},{...other,title:"todo_read"},{...own,status:"failed"}]));
  assert.deepEqual(turnTodos(cards,"execution-A"),newTasks);
  assert.deepEqual(turnTodos(cards,"unrelated"),[]);
  assert.deepEqual(turnTodos([unbound],"execution-A",true),oldTasks);
  const html=renderToStaticMarkup(createElement(TaskProgress,{cards,executionId:"execution-A",historical:true}));
  assert.match(html,/任务进度 1 \/ 2/);
  assert.match(html,/上次进行至此/);
  assert.doesNotMatch(html,/恢复 Master|>进行中</);
});

test("native todo reads and writes retain localized names and stay grouped per execution", () => {
  const native=write("n",10,newTasks);native.title="TodoWrite";native.data={taskId:"execution-A"};
  const read={...native,id:"r",title:"TodoRead"};
  const other={...native,id:"o",data:{taskId:"execution-B"}};
  assert.equal(toolDescription(native),"更新任务进度");
  assert.equal(toolDescription(read),"查看任务进度");
  assert.equal(progressGlyph(native),"lakeWorkflow");
  const groups=conversationGroups([native,read,other].map(card=>({id:card.id,at:card.at,card})));
  assert.deepEqual(groups.map(group=>group.entries.map(e=>e.id)),[["n","r"],["o"]]);
});
