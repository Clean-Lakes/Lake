export function TaskProgress({ steps }: { steps: Record<string, any>[] }) {
  return (
    <section className="panel">
      <h3>共享任务进度</h3>
      {steps.length ? (
        steps.map((s) => (
          <div className="step" key={s.id}>
            <span className={"status " + s.status}>
              {s.status === "succeeded" ? "✓" : "○"}
            </span>
            <div>
              <strong>{s.label}</strong>
              <small>
                {s.status} ·{" "}
                {s.assignee ? String(s.assignee).slice(0, 8) : "待领取"}
              </small>
              {s.dependencies?.length > 0 && (
                <small>
                  依赖{" "}
                  {s.dependencies
                    .map((id: string) => id.slice(0, 8))
                    .join("、")}
                </small>
              )}
            </div>
          </div>
        ))
      ) : (
        <p className="muted">协调者正在建立任务步骤。</p>
      )}
    </section>
  );
}
