import { useState } from "react";
export function Conversation({
  task,
  messages,
  text,
  onSend,
  onResume,
  onCancel,
}: {
  task: Record<string, any> | undefined;
  messages: Record<string, any>[];
  text: string;
  onSend: (text: string) => Promise<void>;
  onResume: () => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(""),
    [sending, setSending] = useState(false);
  return (
    <section className="conversation">
      <header>
        <div>
          <span className="eyebrow">任务目标</span>
          <h2>{task?.objective ?? "选择或创建一个任务会话"}</h2>
        </div>
        {task && (
          <div className="row">
            <span className={"badge " + task.status}>{task.status}</span>
            <button
              disabled={[
                "succeeded",
                "qualified",
                "failed",
                "cancelled",
              ].includes(task.status)}
              onClick={onResume}
            >
              继续
            </button>
            <button
              disabled={[
                "succeeded",
                "qualified",
                "failed",
                "cancelled",
              ].includes(task.status)}
              onClick={onCancel}
            >
              取消任务
            </button>
          </div>
        )}
      </header>
      {task?.status === "waiting" && task.waitingReason && (
        <div className="notice">当前等待：{task.waitingReason}</div>
      )}
      <div className="messages">
        {messages.map((m) => (
          <article className="message user" key={m.id}>
            <small>你</small>
            <p>{m.text}</p>
          </article>
        ))}
        {text && (
          <article className="message">
            <small>会话协调者</small>
            <pre>{text}</pre>
          </article>
        )}
        {!text && (
          <div className="empty">
            <h3>让现场信息推动下一步</h3>
            <p>专员共享进度、终端与证据，独立推进各自的工单。</p>
          </div>
        )}
      </div>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          if (!draft.trim()) return;
          setSending(true);
          try {
            await onSend(draft);
            setDraft("");
          } finally {
            setSending(false);
          }
        }}
      >
        <textarea
          aria-label="追加任务指令"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="补充目标、约束或现场信息…"
        />
        <button
          className="primary"
          disabled={
            sending ||
            !task ||
            ["succeeded", "qualified", "failed", "cancelled"].includes(
              task.status,
            )
          }
        >
          发送
        </button>
      </form>
    </section>
  );
}
