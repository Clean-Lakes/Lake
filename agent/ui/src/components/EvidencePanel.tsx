export function EvidencePanel({
  observations,
  evidence,
  hypotheses,
  onArtifact,
  criteria,
  onConfirm,
}: {
  criteria: Record<string, any>[];
  onConfirm: (id: string) => void;
  observations: Record<string, any>[];
  evidence: Record<string, any>[];
  hypotheses: Record<string, any>[];
  onArtifact: (id: string) => void;
}) {
  return (
    <section className="panel">
      <h3>事实与验收</h3>
      {criteria
        .filter((c) => c.type === "manual")
        .map((c) => (
          <article key={c.id}>
            <p>{c.label}</p>
            {c.confirmedBy ? (
              <small>已由用户确认</small>
            ) : (
              <button onClick={() => onConfirm(c.id)}>
                确认此项人工验收通过
              </button>
            )}
          </article>
        ))}
      {hypotheses.map((h) => (
        <article key={h.id}>
          <strong>{h.claim}</strong>
          <small>
            假设：{h.status} · 支持 {h.supportingEvidence.length} / 反证{" "}
            {h.refutingEvidence.length}
          </small>
        </article>
      ))}
      {observations.slice(-6).map((o) => (
        <details key={o.id}>
          <summary>
            {o.trusted ? "现场观测" : "待核实陈述"} · {o.source}
          </summary>
          <small>
            {o.id} · {o.observedAt} ·{" "}
            {o.invalidatedAt ? "需要重新采集" : "有效期 " + o.expiresAt}
          </small>
          <pre>{JSON.stringify(o.value, null, 2)}</pre>
        </details>
      ))}
      {evidence.map((e) => (
        <article key={e.id}>
          <span className={"badge " + (e.result ? "succeeded" : "failed")}>
            {e.result ? "通过" : "未通过"}
          </span>{" "}
          {e.criterionId}
          <small>
            证据 {String(e.id).slice(0, 8)} · {e.source}
          </small>
          {e.artifactRef && (
            <button onClick={() => onArtifact(e.artifactRef)}>查看产物</button>
          )}
        </article>
      ))}
      {!observations.length && !evidence.length && (
        <p className="muted">采集结果会带来源和时间；完成结论需通过验收。</p>
      )}
    </section>
  );
}
