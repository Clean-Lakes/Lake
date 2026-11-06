import { useEffect, useRef, useState } from "react";
import type {
  LayeredMemoryEntry,
  LayeredMemoryScope,
  LayeredMemoryView,
} from "../../shared/contracts";
import { api, readableError } from "./api";
import { AppSelect } from "./AppSelect";
import { Glyph } from "./Icons";

type Props = {
  projectId?: string;
  projectName?: string;
  onBusyChange: (value: boolean) => void;
};
export function NativeMemorySettings({
  projectId = "",
  projectName,
  onBusyChange,
}: Props) {
  const [scopes, setScopes] = useState<LayeredMemoryScope[]>([]),
    [scopeKey, setScopeKey] = useState(""),
    [view, setView] = useState<LayeredMemoryView | null>(null);
  const [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [editing, setEditing] = useState<{
      id?: string;
      revision: number;
      title: string;
      body: string;
    } | null>(null),
    [forget, setForget] = useState<LayeredMemoryEntry | null>(null);
  const generation = useRef(0),
    titleInput = useRef<HTMLInputElement>(null),
    cancelForget = useRef<HTMLButtonElement>(null),
    editTrigger = useRef<HTMLButtonElement | null>(null),
    forgetTrigger = useRef<HTMLButtonElement | null>(null),
    refreshTrigger = useRef<HTMLButtonElement>(null);
  function restoreFocus(target: HTMLButtonElement | null) {
    requestAnimationFrame(() =>
      (target?.isConnected ? target : refreshTrigger.current)?.focus(),
    );
  }
  function dismissEditor() {
    setEditing(null);
    restoreFocus(editTrigger.current);
  }
  function dismissForget() {
    setForget(null);
    restoreFocus(forgetTrigger.current);
  }
  useEffect(() => {
    const controller = new AbortController();
    void api
      .memoryScopes(projectId, controller.signal)
      .then((value) => {
        setScopes(value.scopes);
        setScopeKey(
          value.scopes.find((scope) => scope.kind === "project")?.key ??
            value.scopes[0]?.key ??
            "",
        );
      })
      .catch((e) => {
        if (!controller.signal.aborted) {
          setError(readableError(e));
          setLoading(false);
        }
      });
    return () => controller.abort();
  }, [projectId]);
  async function refresh(key = scopeKey) {
    const g = ++generation.current;
    setLoading(true);
    try {
      const next = await api.memoryView(key, projectId);
      if (g === generation.current) {
        setView(next);
        setError("");
      }
    } catch (e) {
      if (g === generation.current) setError(readableError(e));
    } finally {
      if (g === generation.current) setLoading(false);
    }
  }
  useEffect(() => {
    setView(null);
    setEditing(null);
    setForget(null);
    setNotice("");
    if (scopeKey) void refresh(scopeKey);
    return () => {
      generation.current++;
    };
  }, [scopeKey, projectId]);
  const processing = view?.jobs.some(
    (job) => job.state === "queued" || job.state === "running",
  );
  useEffect(() => {
    if (!processing || busy) return;
    const timer = setInterval(() => void refresh(), 2000);
    return () => clearInterval(timer);
  }, [processing, busy, scopeKey, projectId]);
  useEffect(() => {
    if (editing) titleInput.current?.focus();
  }, [editing?.id, !!editing]);
  useEffect(() => {
    if (forget) cancelForget.current?.focus();
  }, [forget?.id]);
  async function run(task: () => Promise<void>) {
    setBusy(true);
    onBusyChange(true);
    setError("");
    try {
      await task();
    } catch (e) {
      setError(readableError(e));
    } finally {
      setBusy(false);
      onBusyChange(false);
    }
  }
  const scope = scopes.find((scope) => scope.key === scopeKey),
    disabled = busy || loading;
  async function settings(useEnabled: boolean, extractionEnabled: boolean) {
    if (!view) return;
    await api.memorySettings(scopeKey, projectId, {
      ...view.settings,
      useEnabled,
      extractionEnabled,
    });
    await refresh();
    setNotice("记忆设置已保存。关闭开关会保留已保存的内容。");
  }
  return (
    <section
      id="memory-settings-panel"
      role="tabpanel"
      aria-labelledby="memory-settings-tab"
      className="memory-settings"
    >
      <label className="field-label">
        记忆范围
        <AppSelect
          label="记忆范围"
          value={scopeKey}
          disabled={busy || !scopes.length}
          onChange={(event) => setScopeKey(event.target.value)}
        >
          {scopes.map((scope) => (
            <option key={scope.key} value={scope.key}>
              {scope.kind === "user"
                ? "所有项目的偏好"
                : scope.kind === "project"
                  ? `当前项目 · ${projectName || scope.name}`
                  : `专员 · ${scope.name}`}
            </option>
          ))}
        </AppSelect>
      </label>
      <p className="memory-scope-note">
        {scope?.kind === "user"
          ? "这里保存你明确允许跨项目使用的偏好，供 Pilot 使用。项目对话不会自动共享到这里。"
          : scope?.kind === "role"
            ? "这位专员的知识可跨任务保留。临时子智能体的有效发现由父任务汇合后积累，其他专员不会自动读取。"
            : "项目共享知识由 Pilot 和本项目专员按需读取。专员各自的经验保存在其专员范围。"}
      </p>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="settings-note" role="status">
          {notice}
        </p>
      )}
      {view && (
        <>
          {view.search?.engine==='claude-mem-sqlite'&&<p className="settings-note" role="status">已接入 Claude-Mem 本地检索。</p>}
          {(view.search?.error||!!view.search?.pendingDeletions)&&<p className="settings-note" role="status">{view.search?.error??'记忆已停止使用，本地检索副本尚待清理；服务恢复后会继续清理。'}</p>}
          <section className="memory-controls" aria-label="记忆开关">
            {scope?.kind !== "user" && (
              <label className="memory-control">
                <span>
                  <strong>自动积累知识</strong>
                  <span>
                    从开启后的新对话、有验收证据的任务及已确认的只读失败中提取可复用知识。
                  </span>
                </span>
                <input
                  aria-label="自动积累知识"
                  type="checkbox"
                  disabled={disabled}
                  checked={view.settings.extractionEnabled}
                  onChange={(event) =>
                    void run(() =>
                      settings(view.settings.useEnabled, event.target.checked),
                    )
                  }
                />
              </label>
            )}
            <label className="memory-control">
              <span>
                <strong>回答时使用记忆</strong>
                <span>按当前项目和专员范围读取相关内容。</span>
              </span>
              <input
                aria-label="回答时使用记忆"
                type="checkbox"
                disabled={disabled}
                checked={view.settings.useEnabled}
                onChange={(event) =>
                  void run(() =>
                    settings(
                      event.target.checked,
                      view.settings.extractionEnabled,
                    ),
                  )
                }
              />
            </label>
            <p className="memory-control-hint">
              {scope?.kind === "user"
                ? "这里只保存你明确提交的偏好。"
                : "当前项目及其专员共用这组开关，各自的知识内容仍独立。开启积累后可能产生额外模型请求和 Token 用量。"}
            </p>
          </section>
          <section aria-label="已保存的知识">
            <header className="memory-section-header">
              <h4>已保存的知识</h4>
              <div className="memory-toolbar">
                <button
                  type="button"
                  className="memory-text-button"
                  disabled={disabled}
                  onClick={(event) => {
                    editTrigger.current = event.currentTarget;
                    setForget(null);
                    setEditing({ revision: 0, title: "", body: "" });
                  }}
                >
                  保存一条记忆
                </button>
                <button
                  type="button"
                  className="icon-button"
                  aria-label="刷新记忆"
                  ref={refreshTrigger}
                  disabled={disabled}
                  onClick={() => void run(() => refresh())}
                >
                  <Glyph name="refresh" size={15} />
                </button>
              </div>
            </header>
            {!view.items.length && !loading && (
              <p className="memory-empty">
                还没有保存知识。
                {scope?.kind === "user"
                  ? "你可以明确保存一条跨项目偏好。"
                  : "开启自动积累后，正常交流和执行任务即可。"}
              </p>
            )}
            {view.items.map((entry) => (
              <article key={entry.id} className="memory-preference-item">
                <strong>{entry.title}</strong>
                <p className="memory-preference-content">
                  {entry.available
                    ? entry.body
                    : "来源或当前资格已变化，暂不用于回答。"}
                </p>
                <div className="memory-item-actions">
                  <details className="memory-metadata">
                    <summary>来源与版本</summary>
                    <p>
                      版本 {entry.revision} ·{" "}
                      {new Date(entry.updatedAt).toLocaleString()}
                    </p>
                    {entry.sources?.map((source) => (
                      <p key={source.id} className="memory-identifier">
                        {source.kind === "task"
                          ? source.evidenceState === "failed"
                            ? "来自已确认的只读失败"
                            : "来自已验收任务"
                          : source.kind === "manual"
                            ? "由你明确保存"
                            : "来自真实用户消息"}{" "}
                        · {new Date(source.createdAt).toLocaleString()}
                        {source.taskId && ` · ${source.taskId}`}
                      </p>
                    ))}
                  </details>
                  <div className="memory-toolbar">
                    <button
                      type="button"
                      className="memory-text-button"
                      disabled={disabled}
                      onClick={(event) => {
                        editTrigger.current = event.currentTarget;
                        setForget(null);
                        setEditing({
                          id: entry.id,
                          revision: entry.revision,
                          title: entry.title,
                          body: entry.body ?? "",
                        });
                      }}
                    >
                      更正
                    </button>
                    <button
                      type="button"
                      className="memory-text-button"
                      disabled={disabled}
                      onClick={(event) => {
                        forgetTrigger.current = event.currentTarget;
                        setEditing(null);
                        setForget(entry);
                      }}
                    >
                      遗忘
                    </button>
                  </div>
                </div>
              </article>
            ))}
          </section>
          {editing && (
            <form
              className="memory-editor"
              aria-label={editing.id ? "更正记忆" : "保存记忆"}
              onKeyDown={(event) => {
                if (event.key === "Escape" && !busy) {
                  event.preventDefault();
                  event.stopPropagation();
                  dismissEditor();
                }
              }}
              onSubmit={(event) => {
                event.preventDefault();
                void run(async () => {
                  setView(
                    await api.saveMemory(
                      scopeKey,
                      projectId,
                      {
                        title: editing.title,
                        body: editing.body,
                        expectedRevision: editing.revision,
                      },
                      editing.id,
                    ),
                  );
                  dismissEditor();
                  setNotice("记忆已保存。");
                });
              }}
            >
              <label className="field-label">
                标题
                <input
                  ref={titleInput}
                  value={editing.title}
                  maxLength={160}
                  required
                  disabled={busy}
                  onChange={(event) =>
                    setEditing({ ...editing, title: event.target.value })
                  }
                />
              </label>
              <label className="field-label">
                内容
                <textarea
                  value={editing.body}
                  maxLength={16384}
                  rows={5}
                  required
                  disabled={busy}
                  onChange={(event) =>
                    setEditing({ ...editing, body: event.target.value })
                  }
                />
              </label>
              <div className="memory-toolbar">
                <button
                  type="button"
                  className="button secondary"
                  disabled={busy}
                  onClick={dismissEditor}
                >
                  取消
                </button>
                <button
                  type="submit"
                  className="button"
                  disabled={
                    busy || !editing.title.trim() || !editing.body.trim()
                  }
                >
                  保存
                </button>
              </div>
            </form>
          )}
          {forget && (
            <div
              role="group"
              aria-label="确认遗忘记忆"
              className="memory-forget-confirm"
              onKeyDown={(event) => {
                if (event.key === "Escape" && !busy) {
                  event.preventDefault();
                  event.stopPropagation();
                  dismissForget();
                }
              }}
            >
              <p>
                遗忘「{forget.title}」及依赖它的知识？原任务和执行记录会保留。
              </p>
              <div className="memory-toolbar">
                <button
                  ref={cancelForget}
                  type="button"
                  className="button secondary"
                  disabled={busy}
                  onClick={dismissForget}
                >
                  取消
                </button>
                <button
                  type="button"
                  className="button secondary danger"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      setView(
                        await api.forgetMemory(
                          scopeKey,
                          projectId,
                          forget.id,
                          forget.revision,
                        ),
                      );
                      setForget(null);
                      restoreFocus(refreshTrigger.current);
                      setNotice("已遗忘相关知识，后续回答不会再读取。");
                    })
                  }
                >
                  确认遗忘
                </button>
              </div>
            </div>
          )}
          <details className="memory-support-details">
            <summary>记忆如何工作</summary>
            <ul>
              <li>
                新任务使用独立上下文，专员知识按稳定身份保留。改名保留知识，新建同名专员不会继承。
              </li>
              <li>历史数值和观测不代表当前状态，需要时仍会查询实际资源。</li>
              <li>
                已使用的知识被停用或撤回后，受影响的任务会停止续接，原执行记录保留；可新建任务继续。
              </li>
              <li>
                积累与使用独立控制；关闭积累不会删除内容，也不会补扫开启前的历史。
              </li>
            </ul>
          </details>
          {view.jobs.length > 0 && (
            <details className="memory-support-details">
              <summary>整理状态{processing ? " · 正在等待或处理" : ""}</summary>
              {view.jobs
                .slice(-5)
                .reverse()
                .map((job) => (
                  <p key={job.id} className="settings-note">
                    {(
                      {
                        queued: "等待前台任务结束",
                        running: "正在提取知识",
                        completed: "已完成整理",
                        failed: "本次未完成，来源保留",
                        withdrawn: "已取消旧整理结果",
                        interrupted: "上次处理已中断，未重派",
                      } as Record<string, string>
                    )[job.state] ?? job.state}
                    {job.error && ` · ${job.error}`}
                  </p>
                ))}
            </details>
          )}
        </>
      )}
      {loading && !view && (
        <p className="settings-note" role="status">
          正在读取记忆…
        </p>
      )}
    </section>
  );
}
