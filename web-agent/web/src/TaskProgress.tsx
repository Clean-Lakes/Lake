import {DisclosureSummary} from './DisclosureSummary';
import type {AICard, AITodo} from "../../shared/contracts";
import {Glyph} from "./Icons";

function todoList(value: unknown): AITodo[] | undefined {
  if (!Array.isArray(value) || !value.every(todo => todo && typeof todo.content === "string" && todo.content.trim() && ["pending", "in_progress", "completed"].includes(todo.status))) return;
  return value as AITodo[];
}

// Only a successful write adopts progress for this turn. A session-wide list
// or a todo_read may describe earlier work, and must not move it to this reply.
export function turnTodos(cards: AICard[]): AITodo[] {
  const latest = cards.filter(card => card.type === "operation" && card.title === "todo_write" && card.status === "completed").at(-1);
  if (!latest) return [];
  try {
    const result = todoList(JSON.parse(latest.content || "").todos);
    if (result) return result;
  } catch { /* Older or large operation previews may not contain full JSON. */ }
  const data = latest.data as {arguments?: {todos?: unknown}} | undefined;
  return todoList(data?.arguments?.todos) ?? [];
}

export function TaskProgress({cards}: {cards: AICard[]}) {
  const todos = turnTodos(cards);
  if (!todos.length) return null;
  return <details className="ai-task-progress">
    <DisclosureSummary className="thinking-toggle">任务进度 {todos.filter(todo => todo.status === "completed").length} / {todos.length}</DisclosureSummary>
    <div>{todos.map((todo, index) => <div key={index}><span>{todo.status === "completed" ? <span role="img" aria-label="已完成"><Glyph name="check" size={12}/></span> : todo.status === "in_progress" ? "进行中" : "待处理"}</span> {todo.content}</div>)}</div>
  </details>;
}
