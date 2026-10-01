import { lstat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import type { LakeRuntimeOptions } from "../../domain/protocol.js";
import type { JsonValue } from "../../domain/json.js";
import { object, text, type Params } from "../../domain/validation.js";
import { ZCodeProtocol } from "./protocol.js";

export async function inspectNativeSubagents(
  root: string,
  options: LakeRuntimeOptions,
  input: Params,
): Promise<JsonValue> {
  const owner = text(input, "id"),
    directory = join(root, "zcode-runtime", createHash("sha256").update(owner).digest("hex"));
  try {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("原生会话目录无效");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const workspace = text(input, "workspace") || join(directory, "workspace"),
    cli =
      options.cliPath ?? process.env.LAKE_ZCODE_CLI ?? join(dirname(process.execPath), "zcode.cjs");
  const controller = new AbortController(),
    timer = setTimeout(() => controller.abort(), 15_000);
  const protocol = new ZCodeProtocol(
    options.nodePath ?? process.env.LAKE_ZCODE_NODE ?? process.execPath,
    cli,
    directory,
    controller.signal,
    () => {},
    async () => ({
      nativeSearchEnhancementsEnabled: true,
      memoryEnabled: true,
      askUserQuestionAutoResolutionEnabled: false,
    }),
    workspace,
  );
  try {
    const listed = object(
        await protocol.call("session/list", {
          workspace: { workspacePath: workspace, workspaceKey: workspace },
        }),
      ),
      sessions = listed.sessions;
    if (!Array.isArray(sessions) || !sessions.length) return [];
    if (sessions.length !== 1) throw new Error("原生会话身份不唯一");
    const result = object(
      await protocol.call("session/subagents", {
        sessionId: text(object(sessions[0]), "sessionId"),
        endedLimit: 100,
      }),
    );
    return subagentRows(result, owner);
  } finally {
    clearTimeout(timer);
    await protocol.close();
  }
}

export function subagentRows(value: JsonValue, owner: string): JsonValue {
  const result = object(value),
    rows = [
      ...(Array.isArray(result.running) ? result.running : []),
      ...(Array.isArray(object(result.ended).items)
        ? (object(result.ended).items as JsonValue[])
        : []),
    ];
  return rows
    .map(object)
    .map((row) => ({
      id: text(row, "agentId", text(row, "childSessionId")),
      native_session_id: row.childSessionId ?? "",
      conversation_id: owner,
      parent_run_id: "ZCode",
      name: row.subagentType ?? row.title ?? "Agent",
      model: "ZCode",
      status:
        row.status === "success"
          ? "completed"
          : row.status === "lost"
            ? "unknown"
            : (row.status ?? "unknown"),
      created_at: typeof row.startedAt === "number" ? new Date(row.startedAt).toISOString() : "",
      updated_at: typeof row.endedAt === "number" ? new Date(row.endedAt).toISOString() : "",
      native: true,
    }));
}
