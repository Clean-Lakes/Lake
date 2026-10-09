import { createInterface } from "node:readline/promises";
import type { DaemonClient } from "./daemon-client.js";
import { statusText } from "./cli-renderer.js";
import { publicError, requireCondition } from "../domain/errors.js";
import { finalResponse, finishedStatuses, selectModel } from "./cli-exec.js";
const help =
  "/status /resume /model [名称] /approve <行动ID> <摘要> /cancel /help /quit";
export async function interactiveChat(
  client: DaemonClient,
  initialSessionId: string,
  color = "auto",
): Promise<void> {
  const input = createInterface({
    input: process.stdin,
    output: process.stderr,
  });
  let sessionId = initialSessionId,
    stopped = false,
    cursor = "0",
    previous = "",
    reported = "",
    rootActivity:
      | { activity: string; since: string; model: string }
      | undefined,
    lastHeartbeat = Date.now();
  let cancelPromise: Promise<unknown> | undefined;
  const interrupt = () => {
    input.close();
    process.exitCode = 130;
    cancelPromise = client
      .request("GET", `sessions/${sessionId}/snapshot`)
      .then((s) => {
        const task = s.tasks.find((t: any) => t.id === s.session.rootTaskId);
        return client.request(
          "POST",
          `tasks/${task.id}/cancel`,
          {},
          task.revision,
        );
      })
      .catch(() => {});
  };
  input.on("SIGINT", interrupt);
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  const monitor = (async () => {
    while (!stopped) {
      const selected = sessionId;
      try {
        const events = await client.request(
          "GET",
          `sessions/${selected}/activity?after=${cursor}`,
        );
        if (selected !== sessionId) continue;
        for (const e of events) {
          cursor = e.sequence;
          if (e.type === "model.activity" && e.actor === selected)
            rootActivity = {
              activity: String(e.data.activity),
              since: e.occurredAt,
              model: String(e.data.model),
            };
          if (e.type === "model.delta") process.stdout.write(e.data.text ?? "");
        }
        const snap = await client.request(
            "GET",
            `sessions/${selected}/snapshot`,
          ),
          task = snap.tasks.find((t: any) => t.id === snap.session.rootTaskId);
        if (selected !== sessionId) continue;
        const state = JSON.stringify([
          task.status,
          task.waitingReason,
          snap.specialist_runs.map((r: any) => [
            r.id,
            r.state.status,
            r.state.activity,
          ]),
        ]);
        if (state !== previous) {
          previous = state;
          process.stderr.write(
            statusText(
              `\n任务 ${task.status}${task.waitingReason ? " · " + task.waitingReason : ""}；${snap.specialist_runs.length} 位专员\n`,
              task.status,
              color,
            ),
          );
          for (const a of snap.actions.filter(
            (a: any) => a.status === "waiting_approval",
          )) {
            process.stderr.write(
              `待审批 ${a.id} · ${a.capability} · ${a.proposalDigest}\n${JSON.stringify(a.parameters, null, 2)}\n`,
            );
            if (a.parameters.artifactId) {
              const artifact = await client.request(
                "GET",
                `artifacts/${a.parameters.artifactId}`,
              );
              process.stderr.write(artifact.content + "\n");
            }
          }
        }
        if (Date.now() - lastHeartbeat >= 5000) {
          lastHeartbeat = Date.now();
          const labels: string[] = [];
          if (rootActivity?.activity === "model_call")
            labels.push(
              `主会话等待 ${rootActivity.model} · ${Math.max(0, Math.floor((Date.now() - Date.parse(rootActivity.since)) / 1000))}秒`,
            );
          for (const r of snap.specialist_runs.filter(
            (r: any) => r.state.status === "running",
          ))
            labels.push(
              `专员 ${r.id.slice(0, 8)} · ${r.state.activity === "model_call" ? "等待模型" : r.state.activity} · ${Math.max(0, Math.floor((Date.now() - Date.parse(r.state.since)) / 1000))}秒`,
            );
          if (labels.length)
            process.stderr.write("\n" + labels.join("；") + "\n");
        }
        if (finishedStatuses.includes(task.status) && reported !== task.id) {
          reported = task.id;
          process.stdout.write("\n");
          process.stderr.write("任务已结束。输入新目标会创建关联任务。\n");
        }
      } catch (error) {
        if (!stopped) process.stderr.write(publicError(error).message + "\n");
      }
      await new Promise((r) => setTimeout(r, 250));
    }
  })();
  process.stderr.write(`会话 ${sessionId}\n输入补充指令；${help}\n> `);
  try {
    for await (const line of input) {
      const text = line.trim();
      if (text === "/quit") break;
      try {
        if (text === "/help") {
          process.stderr.write(help + "\n");
          continue;
        }
        const snap = await client.request(
            "GET",
            `sessions/${sessionId}/snapshot`,
          ),
          task = snap.tasks.find((t: any) => t.id === snap.session.rootTaskId);
        if (text === "/status")
          process.stderr.write(
            JSON.stringify(
              {
                session: snap.session,
                task,
                specialists: snap.specialist_runs.map((r: any) => ({
                  id: r.id,
                  state: r.state,
                })),
                steps: snap.task_steps,
              },
              null,
              2,
            ) + "\n",
          );
        else if (text === "/resume") {
          if (finishedStatuses.includes(task.status))
            process.stdout.write(
              (await finalResponse(client, sessionId, snap)) + "\n",
            );
          else
            await client.request(
              "POST",
              `sessions/${sessionId}/resume`,
              {},
              snap.session.revision,
            );
        } else if (text === "/cancel")
          await client.request(
            "POST",
            `tasks/${task.id}/cancel`,
            {},
            task.revision,
          );
        else if (text === "/model")
          process.stderr.write(
            JSON.stringify(await client.request("GET", "config"), null, 2) +
              "\n",
          );
        else if (text.startsWith("/model ")) {
          const chosen = await selectModel(client, text.slice(7).trim());
          await client.request(
            "POST",
            `sessions/${sessionId}/model`,
            chosen,
            snap.session.revision,
          );
          process.stderr.write(`模型 ${chosen.model}\n`);
        } else if (text.startsWith("/approve ")) {
          const [, id, digest] = text.split(/\s+/);
          requireCondition(
            id && digest,
            "invalid_input",
            "Use /approve <action ID> <digest>",
          );
          const action = await client.request("GET", `actions/${id}`);
          await client.request(
            "POST",
            `actions/${id}/approve`,
            { digest },
            action.revision,
          );
        } else if (text.startsWith("/"))
          requireCondition(
            false,
            "invalid_input",
            "Unknown command; use /help",
          );
        else if (text) {
          if (finishedStatuses.includes(task.status)) {
            const child = await client.request(
              "POST",
              `sessions/${sessionId}/fork`,
              { objective: text },
              snap.session.revision,
            );
            sessionId = child.id;
            cursor = "0";
            previous = "";
            rootActivity = undefined;
            process.stderr.write(`会话 ${sessionId}\n`);
          } else
            await client.request(
              "POST",
              `sessions/${sessionId}/messages`,
              { text },
              task.revision,
            );
        }
      } catch (error) {
        process.stderr.write(publicError(error).message + "\n");
      }
      process.stderr.write("> ");
    }
  } finally {
    stopped = true;
    input.close();
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
    await monitor;
    await cancelPromise;
  }
}
