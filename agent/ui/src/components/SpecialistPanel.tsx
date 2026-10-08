const phases: Record<string, string> = {
  collecting: "收集现象",
  diagnosing: "复现诊断",
  planning: "制定方案",
  remediating: "修复",
  verifying: "效果验证",
  observing: "观察",
  reporting: "交付报告",
};
const activities: Record<string, string> = {
  idle: "空闲",
  model_call: "正在分析",
  loading_skill: "加载技能",
  opening_terminal: "创建终端",
  attaching_terminal: "关联终端",
  reading_logs: "读取日志",
  querying_resource: "查询资源",
  executing_command: "执行操作",
  editing_config: "变更配置",
  verifying_health: "验证健康",
  waiting_input_control: "等待终端控制",
  waiting_approval: "等待审批",
  waiting_dependency: "等待依赖",
  reconciling: "核对现场",
};
export function SpecialistPanel({
  runs,
  onCancel,
}: {
  runs: Record<string, any>[];
  onCancel: (run: Record<string, any>) => void;
}) {
  return (
    <section className="panel">
      <h3>
        专员协作 <span className="counter">{runs.length}</span>
      </h3>
      {runs.map((r) => (
        <article className="specialist" key={r.id}>
          <div className="row">
            <strong>
              {r.profile?.name ?? "SRE 专员"} · {String(r.id).slice(0, 6)}
            </strong>
            <span className={"badge " + r.state.status}>{r.state.status}</span>
          </div>
          <p>{r.workOrder?.objective}</p>
          <div>
            {phases[r.state.phase]} · {activities[r.state.activity]}
          </div>
          {r.state.waitingReason && (
            <small className="warning">{r.state.waitingReason}</small>
          )}
          <small>
            模型调用 {r.budget?.calls ?? 0} · Power{" "}
            {r.powerBindings?.join("、") || "按需启用"}
          </small>
          {!["succeeded", "failed", "cancelled"].includes(r.state.status) && (
            <button onClick={() => onCancel(r)}>取消专员</button>
          )}
        </article>
      ))}
      {!runs.length && (
        <p className="muted">任务派发后，专员会在这里显示阶段与实际活动。</p>
      )}
    </section>
  );
}
