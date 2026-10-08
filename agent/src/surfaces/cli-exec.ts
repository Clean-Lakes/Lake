import { writeFile, rename, realpath } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { createInterface } from "node:readline/promises";
import type { DaemonClient } from "./daemon-client.js";
import type { CliOptions } from "./cli-options.js";
import { invocationOptions } from "./cli-options.js";
import { requireCondition } from "../domain/errors.js";
import { resultExitCode, statusText } from "./cli-renderer.js";
import { interactiveChat } from "./cli-chat.js";

export const finishedStatuses = [
  "succeeded",
  "qualified",
  "failed",
  "cancelled",
];
export async function selectModel(
  client: DaemonClient,
  model?: string,
  providerId?: string,
) {
  const config = await client.request("GET", "config");
  const chosen =
    config.providers.find((p: any) => p.id === (providerId ?? model)) ??
    (!providerId && model
      ? config.providers.find((p: any) => p.model === model)
      : undefined) ??
    config.providers.find(
      (p: any) => p.id === (providerId ?? config.defaultProvider),
    );
  requireCondition(
    chosen,
    "not_found",
    "Configured model/provider not found; use lake models",
  );
  requireCondition(
    chosen.model !== "unconfigured",
    "precondition_failed",
    "Configure agent/config.json and a private credential reference; use lake models",
  );
  return {
    providerId: chosen.id,
    model: model && model !== chosen.id ? model : chosen.model,
  };
}
export async function readPrompt(
  explicit: string | undefined,
  interactive: boolean,
): Promise<string | undefined> {
  let text = explicit;
  if (!process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of process.stdin) {
      const b = Buffer.from(chunk);
      size += b.length;
      requireCondition(size <= 65536, "output_limit", "Prompt exceeds 64 KiB");
      chunks.push(b);
    }
    const piped = Buffer.concat(chunks).toString("utf8").trim();
    text =
      text && text !== "-"
        ? piped
          ? `${text}\n\n<stdin>\n${piped}\n</stdin>`
          : text
        : piped;
  } else if (text === "-")
    throw new Error("Redirect stdin when using a dash prompt");
  if (!text && interactive) {
    const input = createInterface({
      input: process.stdin,
      output: process.stderr,
    });
    try {
      text = await input.question("目标：");
    } finally {
      input.close();
    }
  }
  if (text)
    requireCondition(
      Buffer.byteLength(text) <= 65536,
      "output_limit",
      "Prompt exceeds 64 KiB",
    );
  return text?.trim() || undefined;
}
async function selectSession(
  client: DaemonClient,
  options: CliOptions,
  cwd: string,
) {
  cwd = await realpath(cwd);
  const explicit =
    options.values.session ??
    (options.values.last ? undefined : options.args[0]);
  const sessions = (await client.request("GET", "sessions"))
    .filter((s: any) => options.values.all || s.invocation?.cwd === cwd)
    .reverse();
  if (explicit) {
    const all = await client.request("GET", "sessions");
    const s = all.find((s: any) => s.id === explicit);
    requireCondition(s, "not_found", "Session ID not found");
    return s;
  }
  requireCondition(
    sessions.length,
    "not_found",
    "No saved sessions for this working directory; use --all",
  );
  if (options.values.last) return sessions[0];
  requireCondition(
    process.stdin.isTTY,
    "invalid_input",
    "Choose a session ID or use --last",
  );
  for (let i = 0; i < sessions.length; i++)
    process.stderr.write(
      `${i + 1}. ${sessions[i].id} · ${sessions[i].status} · ${sessions[i].invocation?.cwd ?? "运维资源"}\n`,
    );
  const input = createInterface({
    input: process.stdin,
    output: process.stderr,
  });
  try {
    const n = Number(await input.question("会话序号："));
    requireCondition(
      Number.isInteger(n) && n > 0 && n <= sessions.length,
      "invalid_input",
    );
    return sessions[n - 1];
  } finally {
    input.close();
  }
}
export async function createCliSession(
  client: DaemonClient,
  options: CliOptions,
  objective: string,
) {
  const config = await client.request("GET", "config");
  const overrides = invocationOptions(
    options.values,
    options.values["ignore-user-config"] ? {} : config.cli,
  );
  const invocation = overrides.invocation;
  if (options.command === "review") {
    invocation.sandboxMode = "read-only";
    invocation.bypassApprovals = false;
  }
  const chosen = await selectModel(
    client,
    invocation.model,
    overrides.providerId,
  );
  invocation.model = chosen.model;
  const lakeId = options.values.lake ?? overrides.selection.lake,
    environmentId =
      options.values.environment ?? overrides.selection.environment;
  let scope: any;
  if (lakeId || environmentId) {
    // Explicit operations scope keeps the original granted-Power behavior.
    if (
      !options.values.sandbox &&
      !options.values["full-auto"] &&
      !options.values["dangerously-bypass-approvals-and-sandbox"] &&
      !overrides.selection.sandbox_mode &&
      options.command !== "review"
    )
      invocation.sandboxMode = "danger-full-access";
    requireCondition(
      lakeId && environmentId,
      "invalid_input",
      "Specify both --lake and --environment",
    );
    const assets = await client.request("GET", "resources");
    scope = {
      lakeId,
      environmentId,
      resourceIds:
        options.values.resource ??
        overrides.selection.resource ??
        assets.resources
          .filter(
            (r: any) =>
              r.lakeId === lakeId && r.environmentId === environmentId,
          )
          .map((r: any) => r.id),
    };
  } else {
    requireCondition(
      !options.values.resource && !overrides.selection.resource,
      "invalid_input",
      "Resource selection needs --lake and --environment",
    );
    scope = await client.request("POST", "workspaces/resolve", {
      roots: invocation.workspaceRoots,
      sandboxMode: invocation.sandboxMode,
    });
    invocation.cwd = scope.roots[0];
    invocation.workspaceRoots = scope.roots;
  }
  requireCondition(
    scope.resourceIds.length,
    "invalid_input",
    "No resources in selected scope",
  );
  return client.request("POST", "sessions", {
    lakeId: scope.lakeId,
    environmentId: scope.environmentId,
    resourceIds: scope.resourceIds,
    objective,
    providerId: chosen.providerId,
    invocation,
    intent: options.values.intent ?? "diagnose",
  });
}
export async function finalResponse(
  client: DaemonClient,
  sessionId: string,
  snapshot?: any,
): Promise<string> {
  const messages = await client.request(
    "GET",
    `sessions/${sessionId}/messages`,
  );
  const text = messages.filter((m: any) => m.text).at(-1)?.text;
  if (text) return text;
  const snap =
      snapshot ??
      (await client.request("GET", `sessions/${sessionId}/snapshot`)),
    task = snap.tasks.find((t: any) => t.id === snap.session.rootTaskId);
  if (task.reportArtifactId)
    return (await client.request("GET", `artifacts/${task.reportArtifactId}`))
      .content;
  return `任务 ${task.status}${task.waitingReason ? " · " + task.waitingReason : ""}`;
}
export async function saveResponse(path: string, text: string): Promise<void> {
  const target = resolve(path),
    tmp = resolve(dirname(target), ".lake-response-" + crypto.randomUUID());
  await writeFile(tmp, text + "\n", { mode: 0o600, flag: "wx" });
  await rename(tmp, target);
}
export async function waitForSession(
  client: DaemonClient,
  session: any,
  options: CliOptions,
): Promise<void> {
  const jsonl = options.command !== "run" && options.values.json,
    legacy = options.command === "run" && options.values.json;
  const emit = (value: unknown) =>
    process.stdout.write(JSON.stringify(value) + "\n");
  if (jsonl) {
    emit({ type: "thread.started", thread_id: session.id });
    emit({ type: "turn.started" });
  } else if (!legacy)
    process.stderr.write(`会话 ${session.id} · ${session.providerId}\n`);
  let cursor = "0",
    printed = false,
    lastStatus = "";
  const controller = new AbortController();
  let cancelling = false,
    cancelPromise: Promise<unknown> | undefined;
  const cancel = () => {
    if (cancelling) return;
    cancelling = true;
    controller.abort();
    cancelPromise = client
      .request("GET", `tasks/${session.rootTaskId}`)
      .then((t) =>
        client.request("POST", `tasks/${t.id}/cancel`, {}, t.revision),
      )
      .catch(() => {});
  };
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    while (!cancelling) {
      const events = await client.request(
        "GET",
        `sessions/${session.id}/activity?after=${cursor}`,
      );
      for (const event of events) {
        cursor = event.sequence;
        if (jsonl) emit(event);
        else if (!legacy && event.type === "model.delta") {
          process.stdout.write(event.data.text ?? "");
          printed = true;
        }
      }
      const snap = await client.request(
          "GET",
          `sessions/${session.id}/snapshot`,
        ),
        task = snap.tasks.find((t: any) => t.id === session.rootTaskId);
      if (!jsonl && !legacy && task.status !== lastStatus) {
        lastStatus = task.status;
        process.stderr.write(
          statusText(
            `\n任务 ${task.status}${task.waitingReason ? " · " + task.waitingReason : ""}\n`,
            task.status,
            options.values.color,
          ),
        );
      }
      const settled =
        finishedStatuses.includes(task.status) ||
        (task.status === "waiting" &&
          !snap.specialist_runs.some((r: any) =>
            ["queued", "running"].includes(r.state.status),
          ));
      if (settled) {
        // Drain all durable events committed before the terminal snapshot.
        while (true) {
          const tail = await client.request(
            "GET",
            `sessions/${session.id}/activity?after=${cursor}`,
          );
          if (!tail.length) break;
          for (const e of tail) {
            cursor = e.sequence;
            if (jsonl) emit(e);
            else if (!legacy && e.type === "model.delta") {
              process.stdout.write(e.data.text ?? "");
              printed = true;
            }
          }
        }
        const result = {
          sessionId: session.id,
          taskId: task.id,
          status: task.status,
          reportArtifactId: task.reportArtifactId ?? null,
          waitingReason: task.waitingReason ?? null,
          ...(task.status === "waiting"
            ? {
                actions: snap.actions
                  .filter((a: any) =>
                    ["waiting_approval", "unknown"].includes(a.status),
                  )
                  .map((a: any) => ({
                    id: a.id,
                    status: a.status,
                    digest: a.proposalDigest,
                    capability: a.capability,
                    parameters: a.parameters,
                  })),
              }
            : {}),
        };
        const response = await finalResponse(client, session.id, snap);
        if (options.values["output-last-message"])
          await saveResponse(options.values["output-last-message"], response);
        if (jsonl)
          emit({
            type: task.status === "failed" ? "turn.failed" : "turn.completed",
            ...result,
            response,
          });
        else if (legacy) emit(result);
        else {
          if (!printed) process.stdout.write(response);
          process.stdout.write("\n");
          if (task.status === "waiting")
            process.stderr.write(
              JSON.stringify(result.actions, null, 2) + "\n",
            );
        }
        process.exitCode = resultExitCode(task.status);
        return;
      }
      await new Promise<void>((r) => {
        const abort = () => {
          clearTimeout(timer);
          r();
        };
        const timer = setTimeout(() => {
          controller.signal.removeEventListener("abort", abort);
          r();
        }, 150);
        controller.signal.addEventListener("abort", abort, { once: true });
      });
    }
  } finally {
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
    await cancelPromise;
    if (cancelling) process.exitCode = 130;
  }
}
export async function runConversation(
  client: DaemonClient,
  options: CliOptions,
): Promise<void> {
  let command = options.command;
  if (command === "exec" && options.args[0] === "resume") {
    command = "resume";
    options = { ...options, command: "exec", args: options.args.slice(1) };
  }
  const interactive =
    options.command !== "exec" &&
    options.command !== "run" &&
    options.command !== "review" &&
    process.stdin.isTTY &&
    !options.values.json;
  let session: any;
  if (command === "resume" || command === "fork" || options.values.session) {
    const config = await client.request("GET", "config"),
      overrides = invocationOptions(options.values, {
        profiles: config.cli?.profiles ?? {},
      });
    session = await selectSession(client, options, overrides.invocation.cwd!);
    const prompt = await readPrompt(
      options.values.prompt ??
        options.args
          .slice(options.values.session || options.values.last ? 0 : 1)
          .join(" "),
      false,
    );
    const snap = await client.request("GET", `sessions/${session.id}/snapshot`),
      task = snap.tasks.find((t: any) => t.id === session.rootTaskId);
    const explicitPolicy =
      options.values.sandbox ||
      options.values["ask-for-approval"] ||
      options.values["full-auto"] ||
      options.values["dangerously-bypass-approvals-and-sandbox"] ||
      overrides.selection.sandbox_mode ||
      overrides.selection.approval_policy;
    const explicitModel = options.values.model ?? overrides.selection.model;
    const modelChange =
      explicitModel ||
      overrides.providerId ||
      overrides.invocation.reasoningEffort;
    const chosen = modelChange
      ? await selectModel(
          client,
          explicitModel ??
            (!overrides.providerId
              ? snap.session.invocation?.model
              : undefined),
          overrides.providerId ??
            (config.providers.some(
              (p: any) => p.id === explicitModel || p.model === explicitModel,
            )
              ? undefined
              : snap.session.providerId),
        )
      : undefined;
    if (
      command === "fork" ||
      (finishedStatuses.includes(task.status) && prompt)
    ) {
      const invocation = {
        ...snap.session.invocation,
        ...(explicitPolicy
          ? {
              sandboxMode: overrides.invocation.sandboxMode,
              approvalPolicy: overrides.invocation.approvalPolicy,
              bypassApprovals: overrides.invocation.bypassApprovals,
            }
          : {}),
        ...(chosen ? { model: chosen.model } : {}),
        ...(overrides.invocation.reasoningEffort
          ? { reasoningEffort: overrides.invocation.reasoningEffort }
          : {}),
        ...(overrides.invocation.maxCalls
          ? { maxCalls: overrides.invocation.maxCalls }
          : {}),
        ...(overrides.invocation.maxTokens
          ? { maxTokens: overrides.invocation.maxTokens }
          : {}),
      };
      requireCondition(
        !options.values["add-dir"],
        "invalid_input",
        "Fork retains resource scope; start a new session to add directories",
      );
      session = await client.request(
        "POST",
        `sessions/${session.id}/fork`,
        {
          ...(prompt ? { objective: prompt } : {}),
          ...(chosen ? { providerId: chosen.providerId } : {}),
          invocation,
        },
        snap.session.revision,
      );
    } else if (finishedStatuses.includes(task.status)) {
      requireCondition(
        !explicitPolicy,
        "conflict",
        "Use fork to change an ended task execution policy",
      );
      if (chosen)
        session = await client.request(
          "POST",
          `sessions/${session.id}/model`,
          {
            ...chosen,
            ...(overrides.invocation.reasoningEffort
              ? { reasoningEffort: overrides.invocation.reasoningEffort }
              : {}),
          },
          snap.session.revision,
        );
    } else {
      requireCondition(
        !explicitPolicy ||
          (snap.session.invocation?.sandboxMode ===
            overrides.invocation.sandboxMode &&
            snap.session.invocation?.approvalPolicy ===
              overrides.invocation.approvalPolicy &&
            snap.session.invocation?.bypassApprovals ===
              overrides.invocation.bypassApprovals),
        "conflict",
        "Session execution policy is frozen; use fork to change it",
      );
      requireCondition(
        !options.values["add-dir"],
        "invalid_input",
        "Session resources are frozen; start a new session to add directories",
      );
      session = snap.session;
      if (chosen)
        session = await client.request(
          "POST",
          `sessions/${session.id}/model`,
          {
            ...chosen,
            ...(overrides.invocation.reasoningEffort
              ? { reasoningEffort: overrides.invocation.reasoningEffort }
              : {}),
          },
          session.revision,
        );
      if (overrides.invocation.maxCalls || overrides.invocation.maxTokens) {
        await client.request(
          "POST",
          `sessions/${session.id}/budget`,
          {
            maxCalls: overrides.invocation.maxCalls ?? session.budget.maxCalls,
            maxTokens:
              overrides.invocation.maxTokens ?? session.budget.maxTokens,
          },
          session.revision,
        );
        session = (
          await client.request("GET", `sessions/${session.id}/snapshot`)
        ).session;
      }
      if (prompt)
        await client.request(
          "POST",
          `sessions/${session.id}/messages`,
          { text: prompt },
          task.revision,
        );
      else
        await client.request(
          "POST",
          `sessions/${session.id}/resume`,
          {},
          session.revision,
        );
    }
  } else {
    const prompt = await readPrompt(
      options.values.prompt ??
        (options.args.join(" ") ||
          (command === "review"
            ? "审查当前工作区，收集有来源的代码问题，给出定位和改进建议。"
            : undefined)),
      interactive,
    );
    requireCondition(prompt, "invalid_input", "Supply a prompt or pipe stdin");
    session = await createCliSession(client, options, prompt);
  }
  if (interactive)
    await interactiveChat(client, session.id, options.values.color);
  else await waitForSession(client, session, options);
}
