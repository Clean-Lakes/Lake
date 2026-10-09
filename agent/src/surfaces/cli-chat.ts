import type { DaemonClient } from "./daemon-client.js";
import { publicError, requireCondition } from "../domain/errors.js";
import { finalResponse, finishedStatuses, selectModel } from "./cli-exec.js";
import { ConversationTerminal } from "./cli-terminal.js";
import { terminalText } from "./cli-renderer.js";
import { VERSION } from "../version.js";

const help = `/status  查看会话和进度\n/model [名称]  查看或切换模型\n/new  开始新对话\n/resume  继续当前任务\n/approve <行动ID> <摘要>  审批行动\n/cancel  取消当前任务\n/help  显示帮助\n/quit 或 /exit  退出（后台任务保留）`;
const states: Record<string, string> = {
  active: "处理中",
  waiting: "等待",
  succeeded: "已完成",
  qualified: "部分完成",
  failed: "失败",
  cancelled: "已取消",
};
const reasons: Record<string, string> = {
  waiting_user_input: "请补充信息",
  no_progress: "暂未取得进展",
  approval_required: "等待审批",
  budget_exhausted: "预算已用尽",
};
const activities: Record<string, string> = {
  model_call: "等待模型",
  idle: "就绪",
  collecting: "收集现象",
  diagnosing: "诊断",
  repairing: "修复",
  verifying: "验证",
};
export interface ChatOptions {
  createSession?: (objective: string, model?: string) => Promise<any>;
  cwd?: string | undefined;
  model?: string | undefined;
}
export async function interactiveChat(
  client: DaemonClient,
  initialSessionId?: string,
  color = "auto",
  options: ChatOptions = {},
): Promise<void> {
  let sessionId = initialSessionId,
    stopped = false,
    cursor = "0",
    reported = "",
    rootText = "",
    streamActor = "";
  let rootActivity:
      | { activity: string; since: string; model: string }
      | undefined,
    snapshot: any;
  let outage = false,
    failures = 0,
    lastInterrupt = 0,
    cancelling: Promise<unknown> | undefined;
  const controller = new AbortController();
  const approvals = new Set<string>();
  const delivered = new Set<string>(),
    delivering = new Map<string, Promise<void>>();
  let modelOverride: string | undefined;
  const cancelTask = async () => {
    if (!sessionId) return;
    const snap = await client.request("GET", `sessions/${sessionId}/snapshot`),
      task = snap.tasks.find((t: any) => t.id === snap.session.rootTaskId);
    if (!finishedStatuses.includes(task.status))
      await client.request(
        "POST",
        `tasks/${task.id}/cancel`,
        {},
        task.revision,
      );
  };
  const interrupt = (mode: "interrupt" | "cancel" = "interrupt") => {
    const task = snapshot?.tasks.find(
      (t: any) => t.id === snapshot.session.rootTaskId,
    );
    if (sessionId && (!task || !finishedStatuses.includes(task.status))) {
      if (!cancelling) {
        ui.activity("正在取消…");
        cancelling = cancelTask()
          .catch((error) => ui.message(publicError(error).message, "notice"))
          .finally(() => {
            cancelling = undefined;
          });
      }
    } else if (mode === "cancel") return;
    else if (Date.now() - lastInterrupt < 1500) ui.close();
    else {
      lastInterrupt = Date.now();
      ui.message("再按一次 Ctrl+C 退出；/quit 可直接退出。", "notice");
    }
  };
  const ui = new ConversationTerminal(interrupt, color);
  const terminate = () => {
    process.exitCode = 130;
    cancelling ??= cancelTask().catch(() => {});
    ui.close();
  };
  const suspend = () => {
    ui.suspend();
    process.kill(process.pid, "SIGSTOP");
  };
  const resume = () => ui.resume();
  process.on("SIGINT", interrupt);
  process.once("SIGTERM", terminate);
  process.on("SIGTSTP", suspend);
  process.on("SIGCONT", resume);
  ui.message(
    `Lake ${VERSION}\n模型  ${options.model ?? "已配置模型"}\n目录  ${options.cwd ?? process.cwd()}\n输入目标开始；/help 查看命令。`,
    "notice",
  );
  if (sessionId) ui.message(`会话 ${sessionId}`, "notice");
  const chooseSession = (id?: string) => {
    ui.flush();
    sessionId = id;
    cursor = "0";
    reported = "";
    rootText = "";
    streamActor = "";
    rootActivity = undefined;
    snapshot = undefined;
    ui.activity(id ? "处理中" : "就绪");
  };
  const consume = (events: any[], selected: string) => {
    for (const e of events) {
      if (selected !== sessionId) return;
      if (BigInt(e.sequence) <= BigInt(cursor)) continue;
      if (e.type === "model.activity" && e.actor === selected) {
        rootActivity = {
          activity: String(e.data.activity),
          since: e.occurredAt,
          model: String(e.data.model),
        };
        if (e.data.activity !== "model_call") ui.flush();
      }
      if (e.type === "model.delta" && e.data.text) {
        if (streamActor !== e.actor) {
          ui.flush();
          streamActor = e.actor;
          if (e.actor !== selected)
            ui.message(`专员 ${e.actor.slice(0, 8)}`, "notice");
        }
        ui.stream(e.data.text);
        if (e.actor === selected) rootText += terminalText(e.data.text);
      }
      if (e.type === "action.finished") {
        ui.flush();
        const a = e.data.entity;
        if (a)
          ui.message(
            `  ${a.status === "succeeded" ? "✓" : "·"} ${a.capability} · ${a.status === "succeeded" ? "已验证" : a.status}`,
            "notice",
          );
      }
      cursor = e.sequence;
    }
  };
  const renderFinal = async (snap: any, selected: string) => {
    const task = snap.tasks.find((t: any) => t.id === snap.session.rootTaskId);
    if (delivered.has(task.id)) return;
    if (delivering.has(task.id)) return delivering.get(task.id);
    const pending = (async () => {
      while (BigInt(cursor) < BigInt(snap.cursor ?? cursor)) {
        const tail = await client.request(
          "GET",
          `sessions/${selected}/activity?after=${cursor}`,
          undefined,
          0,
          undefined,
          controller.signal,
        );
        if (selected !== sessionId || !tail.length) break;
        consume(tail, selected);
      }
      const answer = await finalResponse(client, selected, snap);
      if (selected !== sessionId) return;
      ui.flush();
      if (!rootText.includes(answer)) ui.message(answer);
      delivered.add(task.id);
      reported = task.id;
      ui.activity(`${states[task.status] ?? task.status} · 输入下一条继续`);
    })();
    delivering.set(task.id, pending);
    try {
      await pending;
    } finally {
      delivering.delete(task.id);
    }
  };
  const pause = (ms: number) =>
    new Promise<void>((done) => {
      if (controller.signal.aborted) return done();
      const abort = () => {
        clearTimeout(timer);
        done();
      };
      const timer = setTimeout(() => {
        controller.signal.removeEventListener("abort", abort);
        done();
      }, ms);
      controller.signal.addEventListener("abort", abort, { once: true });
    });
  const monitor = (async () => {
    while (!stopped) {
      const selected = sessionId;
      if (!selected) {
        await pause(150);
        continue;
      }
      try {
        const events = await client.request(
          "GET",
          `sessions/${selected}/activity?after=${cursor}`,
          undefined,
          0,
          undefined,
          controller.signal,
        );
        if (selected !== sessionId) continue;
        consume(events, selected);
        const snap = await client.request(
          "GET",
          `sessions/${selected}/snapshot`,
          undefined,
          0,
          undefined,
          controller.signal,
        );
        if (selected !== sessionId) continue;
        snapshot = snap;
        if (outage) {
          outage = false;
          ui.message("已重新连接，继续当前会话。", "notice");
        }
        failures = 0;
        const task = snap.tasks.find(
          (t: any) => t.id === snap.session.rootTaskId,
        );
        const active = snap.specialist_runs.filter((r: any) =>
          ["queued", "running"].includes(r.state.status),
        );
        const seconds = rootActivity
          ? Math.max(
              0,
              Math.floor((Date.now() - Date.parse(rootActivity.since)) / 1000),
            )
          : 0;
        ui.activity(
          [
            states[task.status] ?? task.status,
            task.waitingReason
              ? (reasons[task.waitingReason] ?? task.waitingReason)
              : undefined,
            task.status === "active" && rootActivity
              ? `${activities[rootActivity.activity] ?? rootActivity.activity} · ${rootActivity.model} · ${seconds}s`
              : undefined,
            active.length ? `${active.length} 位专员工作中` : undefined,
          ]
            .filter(Boolean)
            .join(" · "),
        );
        for (const a of snap.actions.filter(
          (a: any) => a.status === "waiting_approval",
        )) {
          const key = `${a.id}:${a.proposalDigest}`;
          if (approvals.has(key)) continue;
          approvals.add(key);
          ui.message(
            `待审批 ${a.capability}\n${JSON.stringify(a.parameters, null, 2)}\n/approve ${a.id} ${a.proposalDigest}`,
            "notice",
          );
          if (a.parameters.artifactId)
            ui.message(
              (
                await client.request(
                  "GET",
                  `artifacts/${a.parameters.artifactId}`,
                )
              ).content,
              "notice",
            );
        }
        if (finishedStatuses.includes(task.status) && reported !== task.id) {
          // The terminal snapshot can race the preceding activity fetch. Drain
          // through its committed cursor before rendering the durable report.
          await renderFinal(snap, selected);
        }
      } catch (error) {
        if (stopped) break;
        failures++;
        if (!outage) {
          outage = true;
          ui.flush();
          ui.message(
            `${publicError(error).message}。正在重连；可以继续编辑输入。`,
            "notice",
          );
        }
        ui.activity(`连接中断 · ${failures} 次重试`);
      }
      await pause(
        failures
          ? Math.min(8000, 500 * 2 ** Math.min(failures - 1, 4))
          : reported
            ? 1000
            : 250,
      );
    }
  })();
  try {
    while (true) {
      const line = await ui.nextLine();
      if (line === undefined) break;
      const text = line.trim();
      if (!text) continue;
      if (["/quit", "/exit"].includes(text)) break;
      try {
        if (text === "/help") {
          ui.message(help, "notice");
          continue;
        }
        if (text === "/new") {
          chooseSession();
          ui.message("新对话：输入目标开始。", "notice");
          continue;
        }
        if (text === "/model") {
          const config = await client.request("GET", "config");
          ui.message(
            config.providers
              .map(
                (p: any) =>
                  `${p.id === config.defaultProvider ? "›" : " "} ${p.id} · ${p.model}`,
              )
              .join("\n") + "\n/model <名称> 切换",
            "notice",
          );
          continue;
        }
        if (!sessionId) {
          if (text.startsWith("/model ")) {
            const chosen = await selectModel(client, text.slice(7).trim());
            modelOverride = text.slice(7).trim();
            ui.message(`模型 ${chosen.model}`, "notice");
            continue;
          }
          requireCondition(
            !text.startsWith("/"),
            "invalid_input",
            "请先输入目标；/help 查看命令",
          );
          requireCondition(
            options.createSession,
            "invalid_input",
            "请退出后重新启动新对话",
          );
          ui.activity("正在创建任务…");
          const s = await options.createSession(text, modelOverride);
          chooseSession(s.id);
          continue;
        }
        const selected = sessionId,
          snap = await client.request("GET", `sessions/${selected}/snapshot`),
          task = snap.tasks.find((t: any) => t.id === snap.session.rootTaskId);
        if (text === "/status")
          ui.message(
            `会话 ${selected}\n模型 ${snap.session.invocation?.model ?? snap.session.providerId}\n${states[task.status] ?? task.status}${task.waitingReason ? " · " + (reasons[task.waitingReason] ?? task.waitingReason) : ""}\n目标 ${task.objective}\n${snap.task_steps.map((s: any) => `${s.status} · ${s.title ?? s.description ?? s.id}`).join("\n")}`,
            "notice",
          );
        else if (text === "/resume") {
          if (finishedStatuses.includes(task.status))
            ui.message(await finalResponse(client, selected, snap));
          else
            await client.request(
              "POST",
              `sessions/${selected}/resume`,
              {},
              snap.session.revision,
            );
        } else if (text === "/cancel") {
          await cancelTask();
        } else if (text.startsWith("/model ")) {
          const chosen = await selectModel(client, text.slice(7).trim());
          await client.request(
            "POST",
            `sessions/${selected}/model`,
            chosen,
            snap.session.revision,
          );
          modelOverride = text.slice(7).trim();
          ui.message(`模型 ${chosen.model}`, "notice");
        } else if (text.startsWith("/approve ")) {
          const [, id, digest] = text.split(/\s+/);
          requireCondition(
            id && digest,
            "invalid_input",
            "用法 /approve <行动ID> <摘要>",
          );
          const action = await client.request("GET", `actions/${id}`);
          requireCondition(
            action.sessionId === selected,
            "scope_denied",
            "该行动不属于当前会话",
          );
          await client.request(
            "POST",
            `actions/${id}/approve`,
            { digest },
            action.revision,
          );
        } else if (text.startsWith("/"))
          requireCondition(false, "invalid_input", "未知命令；/help 查看帮助");
        else if (finishedStatuses.includes(task.status)) {
          await renderFinal(snap, selected);
          const child = await client.request(
            "POST",
            `sessions/${selected}/fork`,
            { objective: text },
            snap.session.revision,
          );
          chooseSession(child.id);
        } else
          await client.request(
            "POST",
            `sessions/${selected}/messages`,
            { text },
            task.revision,
          );
      } catch (error) {
        ui.message(publicError(error).message, "notice");
      }
    }
  } finally {
    stopped = true;
    controller.abort();
    ui.close();
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
    process.off("SIGTSTP", suspend);
    process.off("SIGCONT", resume);
    await monitor;
    await cancelling;
  }
}
