export function SessionNavigation({
  sessions,
  selected,
  onSelect,
  onNew,
}: {
  sessions: Record<string, any>[];
  selected: string;
  onSelect: (id: string) => void;
  onNew: () => void;
}) {
  return (
    <aside className="navigation">
      <div className="brand">
        <span className="brand-mark">L</span>
        <div>
          Lake<small>运维协作工作台 · 0.0.1</small>
        </div>
      </div>
      <button className="primary" onClick={onNew}>
        ＋ 新建任务会话
      </button>
      <h3>会话</h3>
      {sessions.map((s) => (
        <button
          className={"session-link " + (s.id === selected ? "selected" : "")}
          key={s.id}
          onClick={() => onSelect(s.id)}
        >
          <strong>{String(s.id).slice(0, 8)}</strong>
          <span>{s.status}</span>
        </button>
      ))}
      <footer>共享现场 · 受控行动 · 证据交付</footer>
    </aside>
  );
}
