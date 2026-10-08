export function ArtifactDialog({
  content,
  onClose,
}: {
  content: string;
  onClose: () => void;
}) {
  let data: any;
  try {
    data = JSON.parse(content);
  } catch {}
  const report = data?.delivery && Array.isArray(data.findings);
  return (
    <div className="overlay">
      <section className="dialog artifact">
        <div className="row">
          <h2>{report ? "运维交付报告" : "证据与变更内容"}</h2>
          <button onClick={onClose}>关闭</button>
        </div>
        {report ? (
          <>
            <h3>{data.objective}</h3>
            <p className="notice">
              {data.delivery.status === "verified"
                ? "所有必须验收已通过"
                : data.delivery.status === "qualified"
                  ? "部分验收通过，仍有未验证项"
                  : "任务仍有未完成项"}
            </p>
            <h3>验收结果</h3>
            {data.delivery.criteria.map((c: any) => (
              <p key={c.id}>
                {c.verified ? "✓" : "○"} {c.id} · {c.required ? "必须" : "可选"}
                <small> · 证据 {c.evidenceIds.join("、") || "尚无"}</small>
              </p>
            ))}
            <h3>现场发现</h3>
            {data.findings.map((f: any) => (
              <details key={f.id}>
                <summary>
                  {f.source} · {f.trusted ? "执行侧采集" : "待核实陈述"} ·{" "}
                  {f.observedAt}
                </summary>
                <pre>{JSON.stringify(f.value, null, 2)}</pre>
                <small>观测 {f.id}</small>
              </details>
            ))}
            <h3>行动结果</h3>
            {data.actions.map((a: any) => (
              <details key={a.id}>
                <summary>
                  {a.capability} · {a.status}
                </summary>
                <pre>{JSON.stringify(a.result?.data, null, 2)}</pre>
              </details>
            ))}
            {data.gaps.length > 0 && (
              <>
                <h3>未验证项</h3>
                <p>{data.gaps.join("、")}</p>
              </>
            )}
          </>
        ) : data?.content && data?.path ? (
          <>
            <p>目标文件：{data.path}</p>
            <p>变更前指纹：{data.expectedHash}</p>
            <h3>冻结的新内容</h3>
            <pre>{data.content}</pre>
          </>
        ) : (
          <pre>{data ? JSON.stringify(data, null, 2) : content}</pre>
        )}
      </section>
    </div>
  );
}
