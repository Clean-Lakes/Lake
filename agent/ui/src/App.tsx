import { useCallback, useEffect, useRef, useState } from "react";
import { api, initializeAuth } from "./api/client";
import { EventClient } from "./api/events";
import { SessionStore, type Snapshot } from "./state/session-store";
import { SessionNavigation } from "./components/SessionNavigation";
import { Conversation } from "./components/Conversation";
import { TaskProgress } from "./components/TaskProgress";
import { SpecialistPanel } from "./components/SpecialistPanel";
import { EvidencePanel } from "./components/EvidencePanel";
import { ApprovalPanel } from "./components/ApprovalPanel";
import { ArtifactDialog } from "./components/ArtifactDialog";
import { TerminalPanel } from "./components/TerminalPanel";
import "./style.css";
export default function App() {
  const [ready, setReady] = useState(false),
    [error, setError] = useState(""),
    [sessions, setSessions] = useState<Record<string, any>[]>([]),
    [selected, setSelected] = useState(""),
    [snapshot, setSnapshot] = useState<Snapshot>(),
    [modelText, setModelText] = useState(""),
    [creating, setCreating] = useState(false),
    [assets, setAssets] = useState<any>({
      lakes: [],
      environments: [],
      resources: [],
    }),
    [services, setServices] = useState<Record<string, any>[]>([]),
    [intent, setIntent] = useState("diagnose"),
    [objective, setObjective] = useState(""),
    [environment, setEnvironment] = useState(""),
    [resources, setResources] = useState<string[]>([]),
    [providers, setProviders] = useState<any[]>([]),
    [provider, setProvider] = useState(""),
    [artifact, setArtifact] = useState("");
  const store = useRef(new SessionStore());
  const notify = useCallback(
    (value: unknown) =>
      setError(value instanceof Error ? value.message : "操作失败"),
    [],
  );
  const refresh = useCallback(async () => {
    try {
      setSessions(await api("GET", "sessions"));
      if (selected) {
        const value = await api<Snapshot>(
          "GET",
          `sessions/${selected}/snapshot`,
        );
        store.current.applySnapshot(value);
        setSnapshot(value);
      }
    } catch (e) {
      notify(e);
    }
  }, [selected, notify]);
  useEffect(() => {
    void initializeAuth()
      .then(async () => {
        const list = await api<any[]>("GET", "sessions");
        setSessions(list);
        if (list[0]) setSelected(list[0].id);
        const a = await api("GET", "resources"),
          config = await api("GET", "config");
        setAssets(a);
        setServices(await api("GET", "services"));
        setProviders(config.providers);
        setProvider(config.defaultProvider);
        setReady(true);
      })
      .catch(notify);
  }, [notify]);
  useEffect(() => {
    if (!ready || !selected) return;
    const controller = new AbortController();
    void (async () => {
      const value = await api<Snapshot>("GET", `sessions/${selected}/snapshot`);
      if (controller.signal.aborted) return;
      store.current = new SessionStore();
      store.current.applySnapshot(value);
      setSnapshot(value);
      setModelText("");
      await new EventClient().subscribe(
        selected,
        value.cursor,
        async (event) => {
          if (controller.signal.aborted) return;
          const status = store.current.applyEvent(event);
          if (status === "gap" || event.type === "session.context_changed") {
            const next = await api<Snapshot>(
              "GET",
              `sessions/${selected}/snapshot`,
            );
            store.current.applySnapshot(next);
            setSnapshot(next);
            setSessions((items) =>
              items.map((s) => (s.id === selected ? next.session : s)),
            );
            return next.cursor;
          }
          if (status === "applied") {
            setSnapshot(structuredClone(store.current.snapshot));
            if (store.current.snapshot)
              setSessions((items) =>
                items.map((s) =>
                  s.id === selected ? store.current.snapshot!.session : s,
                ),
              );
            setModelText(store.current.text.get(selected) ?? "");
          }
          return undefined;
        },
        controller.signal,
      );
    })().catch(notify);
    return () => controller.abort();
  }, [selected, ready, notify]);
  const mutate = async (path: string, data: unknown, revision: number) => {
    try {
      setError("");
      await api("POST", path, data, revision);
      await refresh();
    } catch (e) {
      notify(e);
    }
  };
  const task = snapshot?.tasks.find(
    (t) => t.id === snapshot.session.rootTaskId,
  );
  const create = async () => {
    try {
      const env = assets.environments.find((e: any) => e.id === environment);
      if (!env) throw new Error("请选择环境");
      const session = await api("POST", "sessions", {
        lakeId: env.lakeId,
        environmentId: env.id,
        objective,
        resourceIds: resources,
        providerId: provider,
        intent,
      });
      setCreating(false);
      setSelected(session.id);
      setSessions(await api("GET", "sessions"));
    } catch (e) {
      notify(e);
    }
  };
  if (!ready)
    return (
      <div className="welcome">
        <span className="brand-mark">L</span>
        <h1>Lake</h1>
        <p>{error || "正在连接本地运维内核…"}</p>
        {error && <code>lake open</code>}
      </div>
    );
  return (
    <div className="workbench">
      <SessionNavigation
        sessions={sessions}
        selected={selected}
        onSelect={setSelected}
        onNew={() => {
          setCreating(true);
          setError("");
        }}
      />
      <main className="workspace">
        {error && (
          <div role="alert" className="error">
            <span>{error}</span>
            <button onClick={() => setError("")}>关闭</button>
          </div>
        )}
        <div className="topbar">
          <span>会话 {selected ? selected.slice(0, 8) : "未选择"}</span>
          <span>
            {snapshot?.resources.length ?? 0} 个资源 ·{" "}
            {snapshot?.specialist_runs.length ?? 0} 位专员
          </span>
        </div>
        <div className="collaboration">
          <Conversation
            task={task}
            messages={snapshot?.session_messages ?? []}
            text={modelText}
            onSend={(text) =>
              task
                ? mutate(
                    `sessions/${selected}/messages`,
                    { text },
                    task.revision,
                  )
                : Promise.resolve()
            }
            onResume={() => {
              if (snapshot)
                void mutate(
                  `sessions/${selected}/resume`,
                  {},
                  snapshot.session.revision,
                );
            }}
            onCancel={() => {
              if (task)
                void mutate(`tasks/${task.id}/cancel`, {}, task.revision);
            }}
          />
          <aside className="right-column">
            <TaskProgress steps={snapshot?.task_steps ?? []} />
            <SpecialistPanel
              runs={snapshot?.specialist_runs ?? []}
              onCancel={(r) =>
                void mutate(`specialists/${r.id}/cancel`, {}, r.revision)
              }
            />
            <ApprovalPanel
              onArtifact={(id) =>
                void api("GET", `artifacts/${id}`)
                  .then((value) => setArtifact(value.content))
                  .catch(notify)
              }
              actions={snapshot?.actions ?? []}
              onApprove={(a) =>
                void mutate(
                  `actions/${a.id}/approve`,
                  { digest: a.proposalDigest },
                  a.revision,
                )
              }
              onReconcile={(a) =>
                void mutate(`actions/${a.id}/reconcile`, {}, a.revision)
              }
            />
            <EvidencePanel
              criteria={task?.acceptanceCriteria ?? []}
              onConfirm={(id) => {
                if (task)
                  void mutate(
                    `tasks/${task.id}/criteria/${encodeURIComponent(id)}/confirm`,
                    { confirmed: true },
                    task.revision,
                  );
              }}
              observations={snapshot?.observations ?? []}
              evidence={snapshot?.evidence ?? []}
              hypotheses={snapshot?.hypotheses ?? []}
              onArtifact={(id) =>
                void api("GET", `artifacts/${id}`)
                  .then((value) => setArtifact(value.content))
                  .catch(notify)
              }
            />
            {task?.reportArtifactId && (
              <button
                className="report-button"
                onClick={() =>
                  void api("GET", `artifacts/${task.reportArtifactId}`)
                    .then((v) => setArtifact(v.content))
                    .catch(notify)
                }
              >
                查看交付报告
              </button>
            )}
          </aside>
        </div>
        <TerminalPanel
          terminals={snapshot?.execution_sessions ?? []}
          onChanged={refresh}
          onError={notify}
        />
      </main>
      {creating && (
        <div className="overlay">
          <section className="dialog">
            <h2>新建任务会话</h2>
            <label>
              环境
              <select
                value={environment}
                onChange={(e) => {
                  setEnvironment(e.target.value);
                  setResources([]);
                }}
              >
                <option value="">选择已导入的环境</option>
                {assets.environments.map((e: any) => (
                  <option key={e.id} value={e.id}>
                    {e.name} · {e.classification}
                  </option>
                ))}
              </select>
            </label>
            <label>
              服务范围
              <select
                value=""
                onChange={(e) => {
                  const service = services.find((s) => s.id === e.target.value);
                  if (service) {
                    setEnvironment(service.environmentId);
                    setResources(
                      service.resourceBindings.map((b: any) => b.resourceId),
                    );
                  }
                }}
              >
                <option value="">选择已登记服务，或手动选择资源</option>
                {services
                  .filter(
                    (s) => !environment || s.environmentId === environment,
                  )
                  .map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                      {s.health ? " · 已配置业务健康验收" : ""}
                    </option>
                  ))}
              </select>
            </label>
            <label>
              模型
              <select
                value={provider}
                onChange={(e) => setProvider(e.target.value)}
              >
                {providers.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.model} {!p.supportsTools ? "· 待配置" : ""}
                  </option>
                ))}
              </select>
            </label>
            <fieldset>
              <legend>本次任务资源范围</legend>
              {assets.resources
                .filter((r: any) => r.environmentId === environment)
                .map((r: any) => (
                  <label className="check" key={r.id}>
                    <input
                      type="checkbox"
                      checked={resources.includes(r.id)}
                      onChange={(e) =>
                        setResources(
                          e.target.checked
                            ? [...resources, r.id]
                            : resources.filter((id) => id !== r.id),
                        )
                      }
                    />
                    {r.name} <small>{r.kind}</small>
                  </label>
                ))}
            </fieldset>
            <label>
              任务类型
              <select
                value={intent}
                onChange={(e) => setIntent(e.target.value)}
              >
                <option value="diagnose">诊断调查</option>
                <option value="recover">恢复服务（需业务健康验收）</option>
                <option value="change">配置变更（需业务健康验收）</option>
              </select>
            </label>
            <label>
              目标
              <textarea
                value={objective}
                onChange={(e) => setObjective(e.target.value)}
                placeholder="说明症状、目标和限制…"
              />
            </label>
            {!assets.environments.length && (
              <p className="notice">
                先通过 resources import 导入环境和资源，再为资源授予所需权限。
              </p>
            )}
            <div className="row">
              <button onClick={() => setCreating(false)}>取消</button>
              <button
                className="primary"
                disabled={!objective || !resources.length}
                onClick={() => void create()}
              >
                创建并开始
              </button>
            </div>
          </section>
        </div>
      )}
      {artifact && (
        <ArtifactDialog content={artifact} onClose={() => setArtifact("")} />
      )}
    </div>
  );
}
