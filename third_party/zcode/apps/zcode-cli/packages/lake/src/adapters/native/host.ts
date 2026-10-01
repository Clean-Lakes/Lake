import { homedir } from "node:os";
import { join, relative } from "node:path";
import {
  createFileService,
  createGitService,
  createTerminalService,
  appSettingsSchema,
} from "@zcode/services/lake-host";
import type { DataPort } from "../../app/ports.js";
import type { LakeEvent } from "../../domain/protocol.js";
import type { JsonValue } from "../../domain/json.js";
import { object, redact, text, type Params } from "../../domain/validation.js";
import { projectFile, registeredRoot } from "../workspace/files.js";
import { sensitivePath } from "../../domain/workspace.js";
import { NativeRemoteHost } from "./remote.js";
import { NativeExtensions } from "./extensions.js";

/** Registered Lake IDs and presentation DTOs around native ZCode services. */
export class NativeDesktopHost {
  private readonly files = createFileService();
  private readonly git = createGitService();
  private readonly terminal = createTerminalService({
    settingService: { get: async () => appSettingsSchema.parse({}) },
  });
  private readonly terminals = new Map<string, { project: Params; dispose(): void }>();
  private readonly taskTerminals = new Map<string, string>();
  private readonly extensions: NativeExtensions;
  constructor(
    private readonly data: DataPort,
    private readonly emit: (event: LakeEvent) => void,
    private readonly remote?: NativeRemoteHost,
    root = process.env.LAKE_HOME ?? join(homedir(), ".lake"),
  ) {
    this.extensions = new NativeExtensions(data, root);
  }
  async request(method: string, params: Params, signal: AbortSignal): Promise<JsonValue> {
    signal.throwIfAborted();
    if (method.startsWith("remote.workbench.")) {
      if (!this.remote) throw new Error("原生远程宿主未配置");
      return this.remote.request(method, params, signal);
    }
    if (method.startsWith("native.")) return this.extensions.request(method, params);
    if (method.startsWith("task.")) return this.taskRequest(method, params, signal);
    if (method.startsWith("workbench.terminal.") && method !== "workbench.terminal.open")
      return this.terminalRequest(method, params);
    const project = object(await this.data.request("code.get", { id: text(params, "project_id") })),
      root = await registeredRoot(text(project, "path"));
    if (method === "workbench.files") {
      const entries = await this.files.searchWorkspaceFiles({
        rootPath: root,
        query: text(params, "filter"),
        limit: 500,
      });
      const paths: string[] = [];
      for (const entry of entries)
        if (entry.type === "file" && !sensitivePath(entry.relativePath)) {
          try {
            await projectFile(root, entry.relativePath);
            paths.push(entry.relativePath);
          } catch {
            /* Native index may contain a stale/outside symlink. */
          }
        }
      return paths;
    }
    if (method === "workbench.read") {
      const path = await projectFile(root, text(params, "path")),
        result = await this.files.readTextFile({ path, length: 64 * 1024 });
      if (result.isBinary) throw new Error("文件为二进制内容");
      const lines = result.content.replaceAll("\r\n", "\n").split("\n");
      return {
        path: text(params, "path"),
        lines: lines.slice(0, 200).map((line, index) => `${index + 1}: ${redact(line, 4096)}`),
        truncated: lines.length > 200 || result.truncated,
      };
    }
    if (method === "workbench.git") {
      const summary = await this.git.getRepositorySummary({ workspacePath: root });
      if (!summary.isRepository) return { branch: "", files: [], commits: [], graph: "" };
      const changes = await this.git.getChanges({ workspacePath: root, sourceId: "unstaged" }),
        graph = await this.git.getCommitGraph({ workspacePath: root, maxCount: 20 });
      return {
        branch: summary.branchName ?? "(detached)",
        files: changes
          .filter((change) => !sensitivePath(change.workspaceRelativePath))
          .map((change) => ({
            path: change.workspaceRelativePath,
            status: `${change.x ?? " "}${change.y ?? " "}`,
          })),
        commits: graph.commits.map((commit) => ({
          hash: commit.hash,
          short: commit.hash.slice(0, 8),
          subject: redact(commit.subject),
          author: commit.authorName ?? "",
          date: commit.authoredAtMs ? new Date(commit.authoredAtMs).toISOString() : "",
        })),
        graph: graph.commits
          .map((commit) => `* ${commit.hash.slice(0, 8)} ${redact(commit.subject)}`)
          .join("\n"),
      };
    }
    if (method === "workbench.diff") {
      const path = await projectFile(root, text(params, "path"));
      const diff = await this.git.getDiff({
        workspacePath: root,
        path: relative(root, path),
        sourceId: "unstaged",
      });
      return redact(diff.patch ?? diff.summary ?? "", 64 * 1024);
    }
    if (method === "workbench.terminal.open") {
      const created = await this.terminal.create({ cwd: root, cols: 120, rows: 30 });
      const conversation_id = text(params, "conversation_id");
      const data = this.terminal.onDynamicData(created.id)((chunk) =>
        this.emit({
          type: "terminal_data",
          conversation_id,
          terminal_id: created.id,
          text: redact(chunk, 64 * 1024),
        }),
      );
      const exit = this.terminal.onDynamicExit(created.id)((code) => {
        this.emit({
          type: "terminal_exit",
          conversation_id,
          terminal_id: created.id,
          exit_code: code,
        });
        this.terminals.get(created.id)?.dispose();
        this.terminals.delete(created.id);
      });
      this.terminals.set(created.id, {
        project,
        dispose: () => {
          data.dispose();
          exit.dispose();
        },
      });
      return {
        id: created.id,
        shell: created.shell,
        directory: root,
        root,
        user: process.env.USER ?? "",
        running: false,
        native: true,
      };
    }
    throw new Error(`没有对应的 ZCode 原生宿主操作：${method}`);
  }
  private async taskRequest(
    method: string,
    params: Params,
    signal: AbortSignal,
  ): Promise<JsonValue> {
    const conversationID = text(params, "id"),
      conversation = object(await this.data.request("conversation.get", { id: conversationID }));
    if (conversation.remote_workspace_id) {
      if (!this.remote) throw new Error("原生远程宿主未配置");
      return this.remote.request(
        method === "task.run"
          ? "remote.workbench.run"
          : method === "task.status"
            ? "remote.workbench.status"
            : "remote.workbench.close",
        { ...params, id: conversation.remote_workspace_id, conversation_id: conversationID },
        signal,
      );
    }
    let id = this.taskTerminals.get(conversationID);
    if (id && this.terminals.get(id)?.project.id !== conversation.project_id) {
      await this.terminalRequest("workbench.terminal.close", { id });
      this.taskTerminals.delete(conversationID);
      id = undefined;
    }
    if (method === "task.status")
      return id && this.terminals.has(id)
        ? this.terminalRequest("workbench.terminal.status", { id })
        : null;
    if (method === "task.close") {
      this.taskTerminals.delete(conversationID);
      if (id && this.terminals.has(id))
        await this.terminalRequest("workbench.terminal.close", { id });
      return null;
    }
    if (method !== "task.run" || !conversation.project_id)
      throw new Error("当前任务需要绑定 ZCode 本机项目");
    if (!id || !this.terminals.has(id)) {
      id = text(
        object(
          await this.request(
            "workbench.terminal.open",
            { project_id: conversation.project_id, conversation_id: conversationID },
            signal,
          ),
        ),
        "id",
      );
      this.taskTerminals.set(conversationID, id);
    }
    return this.terminalRequest("workbench.terminal.run", { ...params, id });
  }
  private async terminalRequest(method: string, params: Params): Promise<JsonValue> {
    const id = text(params, "id"),
      terminal = this.terminals.get(id);
    if (!terminal) throw new Error("原生终端已关闭");
    if (method === "workbench.terminal.close") {
      terminal.dispose();
      this.terminals.delete(id);
      await this.terminal.dispose({ id });
      return null;
    }
    const project = await this.data.request("code.get", { id: terminal.project.id });
    if (JSON.stringify(project) !== JSON.stringify(terminal.project))
      throw new Error("终端项目绑定已变化，请重新打开");
    if (method === "workbench.terminal.status")
      return {
        id,
        native: true,
        root: terminal.project.path,
        directory: terminal.project.path,
        target: terminal.project.path,
        user: process.env.USER ?? "",
        running: false,
      };
    if (method === "workbench.terminal.run") {
      const command = text(params, "command");
      await this.terminal.write({
        id,
        data: text(params, "data", command === "\u0003" ? command : command + "\n"),
      });
      return { id, status: "submitted", native: true };
    }
    if (method === "workbench.terminal.resize") {
      await this.terminal.resize({ id, cols: Number(params.cols), rows: Number(params.rows) });
      return null;
    }
    throw new Error("未知的原生终端操作");
  }
  async close(): Promise<void> {
    for (const [id, terminal] of this.terminals) {
      terminal.dispose();
      await this.terminal.dispose({ id });
    }
    this.terminals.clear();
    this.taskTerminals.clear();
    await this.remote?.close();
  }
}
