export function ApprovalPanel({
  actions,
  onApprove,
  onReconcile,
  onArtifact,
}: {
  actions: Record<string, any>[];
  onApprove: (action: Record<string, any>) => void;
  onArtifact: (id: string) => void;
  onReconcile: (action: Record<string, any>) => void;
}) {
  const pending = actions.filter((a) =>
    ["waiting_approval", "unknown", "failed", "blocked"].includes(a.status),
  );
  return (
    <section className="panel">
      <h3>行动与审批</h3>
      {pending.map((a) => (
        <article className="action" key={a.id}>
          <div className="row">
            <strong>{a.capability}</strong>
            <span className={"badge " + a.status}>
              {a.status === "unknown" ? "效果待核对" : a.status}
            </span>
          </div>
          <small>
            资源{" "}
            {a.targets.map((t: any) => String(t.id).slice(0, 8)).join("、")}
          </small>
          <details>
            <summary>查看冻结的行动</summary>
            <pre>{JSON.stringify(a.parameters, null, 2)}</pre>
            <small>摘要 {a.proposalDigest}</small>
            {a.parameters.artifactId && (
              <button onClick={() => onArtifact(a.parameters.artifactId)}>
                查看冻结的新配置或补丁
              </button>
            )}
          </details>
          {a.status === "waiting_approval" && (
            <button className="primary" onClick={() => onApprove(a)}>
              批准这项行动
            </button>
          )}
          {a.status === "unknown" && (
            <button onClick={() => onReconcile(a)}>核对真实状态</button>
          )}
          {a.result?.error && (
            <p className="warning">{a.result.error.message}</p>
          )}
        </article>
      ))}
      {!pending.length && (
        <p className="muted">变更行动将显示参数、目标和冻结摘要。</p>
      )}
    </section>
  );
}
