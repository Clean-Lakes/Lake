import { createInterface } from "node:readline/promises";
import { DaemonClient } from "./daemon-client.js";
import { publicError } from "../domain/errors.js";

// Each input uses the current durable revision, just as the Web client does.
export async function interactiveChat(
  client: DaemonClient,
  sessionId: string,
): Promise<void> {
  const input = createInterface({
    input: process.stdin,
    output: process.stderr,
  });
  let stopped = false,
    previous = "";
  const monitor = (async () => {
    while (!stopped) {
      try {
        const snap = await client.request(
          "GET",
          `sessions/${sessionId}/snapshot`,
        );
        const task = snap.tasks.find(
          (t: any) => t.id === snap.session.rootTaskId,
        );
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
            `\n任务 ${task.status}${task.waitingReason ? " · " + task.waitingReason : ""}；${snap.specialist_runs.length} 位专员\n`,
          );
          for (const a of snap.actions.filter(
            (a: any) => a.status === "waiting_approval",
          ))
            process.stderr.write(
              `待审批 ${a.id} · ${a.capability} · ${a.proposalDigest}\n`,
            );
          if (task.reportArtifactId)
            process.stderr.write(`报告产物：${task.reportArtifactId}\n`);
        }
      } catch (error) {
        if (!stopped) process.stderr.write(publicError(error).message + "\n");
      }
      await new Promise((r) => setTimeout(r, 300));
    }
  })();
  process.stderr.write(
    `会话 ${sessionId}\n输入补充指令；命令：/status /resume /approve <行动ID> <摘要> /cancel /quit\n> `,
  );
  try {
    for await (const line of input) {
      const text = line.trim();
      if (text === "/quit") break;
      try {
        const snap = await client.request(
          "GET",
          `sessions/${sessionId}/snapshot`,
        );
        const task = snap.tasks.find(
          (t: any) => t.id === snap.session.rootTaskId,
        );
        if (text === "/status")
          process.stderr.write(
            JSON.stringify(
              {
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
        else if (text === "/resume")
          await client.request(
            "POST",
            `sessions/${sessionId}/resume`,
            {},
            snap.session.revision,
          );
        else if (text === "/cancel")
          await client.request(
            "POST",
            `tasks/${task.id}/cancel`,
            {},
            task.revision,
          );
        else if (text.startsWith("/approve ")) {
          const [, id, digest] = text.split(/\s+/);
          const action = await client.request("GET", `actions/${id}`);
          await client.request(
            "POST",
            `actions/${id}/approve`,
            { digest },
            action.revision,
          );
        } else if (text)
          await client.request(
            "POST",
            `sessions/${sessionId}/messages`,
            { text },
            task.revision,
          );
      } catch (error) {
        process.stderr.write(publicError(error).message + "\n");
      }
      process.stderr.write("> ");
    }
  } finally {
    stopped = true;
    input.close();
    await monitor;
  }
}
