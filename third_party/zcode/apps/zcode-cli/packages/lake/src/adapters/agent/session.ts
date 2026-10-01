import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import type { LakeTool } from "../../domain/agent.js";
import type { LakeEvent, LakeRuntimeOptions } from "../../domain/protocol.js";
import type { JsonValue } from "../../domain/json.js";
import { object, text, type Params } from "../../domain/validation.js";
import { privateDirectory } from "../storage/database.js";
import { createAgentHost } from "./host.js";
import { modelSelection, prepareAgentConfig } from "./config.js";
import { importedLakeHistory } from "./history.js";
import { NativeInteractions } from "./interactions.js";
import { ZCodeProtocol } from "./protocol.js";
import { prepareNativeExtensions } from "./extensions.js";
import type { NativeRemoteSession } from "../native/remote.js";
import { FileVault } from "../vault.js";

/** Owns a native process connection, never native session/tool/background state. */
export class NativeSession {
  readonly lifetime = new AbortController();
  private scope = new AbortController();
  private protocol!: ZCodeProtocol;
  private host!: Awaited<ReturnType<typeof createAgentHost>>;
  private sessionID = "";
  private interaction?: NativeInteractions;
  private onEvent: (method: string, params: Params) => void = () => {};
  private busy = false;
  private ended = false;
  private remote?: { dispose(): void };
  constructor(
    private readonly key: Buffer,
    readonly workspace: string,
    readonly signature: string,
  ) {}
  static async open(
    root: string,
    owner: string,
    workspace: string,
    signature: string,
    key: Buffer,
    config: Params,
    input: Params,
    tools: LakeTool[],
    options: LakeRuntimeOptions,
    remote?: NativeRemoteSession,
    signal?: AbortSignal,
  ): Promise<NativeSession> {
    const runtimeRoot = join(root, "zcode-runtime"),
      directory = join(runtimeRoot, createHash("sha256").update(owner).digest("hex"));
    workspace ||= join(directory, "workspace");
    const session = new NativeSession(key, workspace, signature);
    const abort = () => session.lifetime.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    try {
      signal?.throwIfAborted();
      await privateDirectory(runtimeRoot);
      await privateDirectory(directory);
      if (workspace === join(directory, "workspace")) await privateDirectory(workspace);
      const cli =
        options.cliPath ??
        process.env.LAKE_ZCODE_CLI ??
        join(dirname(process.execPath), "zcode.cjs");
      session.host = await createAgentHost({
        tools,
        apiKey: key,
        provider: object(object(config.model_providers)[text(config, "model_provider")]),
        signal: session.scope.signal,
        nativeTools: true,
      });
      await prepareAgentConfig(directory, cli, config, session.host.url, session.host.token);
      const extensions = await prepareNativeExtensions(
        root,
        directory,
        new FileVault(root),
        workspace,
      );
      const channel = remote
        ? await remote.open(directory, cli, session.host.url, owner)
        : undefined;
      session.remote = channel;
      session.protocol = new ZCodeProtocol(
        options.nodePath ?? process.env.LAKE_ZCODE_NODE ?? process.execPath,
        cli,
        directory,
        session.lifetime.signal,
        (method, params) => {
          if (method === "runtime.closed") session.ended = true;
          session.onEvent(method, params);
        },
        (method, params) =>
          session.interaction
            ? session.interaction.request(method, params)
            : method === "session/requestRuntimePreferences"
              ? Promise.resolve({
                  nativeSearchEnhancementsEnabled: true,
                  memoryEnabled: true,
                  askUserQuestionAutoResolutionEnabled: false,
                })
              : Promise.reject(new Error("原生交互没有对应的宿主")),
        workspace,
        channel?.stream,
      );
      const scope = {
        workspace: { workspacePath: workspace, workspaceKey: workspace },
        mcpServers: [
          {
            name: "lake",
            type: "http",
            url: (channel?.url ?? session.host.url) + "/mcp",
            headers: [{ name: "Authorization", value: "Bearer " + session.host.token }],
            protocolVersion: "legacy",
            timeoutMs: 3_600_000,
          },
          ...extensions.mcp,
        ],
      };
      const listed = object(
          await session.protocol.call("session/list", {
            workspace: scope.workspace,
            includeArchived: true,
          }),
        ),
        sessions = Array.isArray(listed.sessions) ? listed.sessions : [];
      if (sessions.length > 1) throw new Error("原生会话身份不唯一，不能自动选择");
      session.sessionID = text(object(sessions[0]), "sessionId");
      const history = session.sessionID ? undefined : importedLakeHistory(input);
      const result = object(
        await session.protocol.call(
          session.sessionID ? "session/resume" : "session/create",
          session.sessionID
            ? { ...scope, sessionId: session.sessionID }
            : {
                ...scope,
                mode: "build",
                dynamicWorkflowEnabled: true,
                model: modelSelection(config),
                persistence: "immediate",
                titleGenerationEnabled: false,
                ...(input.review_only === true
                  ? { toolAllowlist: ["mcp__lake__lake_conversation_history"] }
                  : {}),
                ...(history ? { importedHistory: history, sessionId: owner } : {}),
              },
        ),
      );
      const returnedID = text(object(result.session), "sessionId");
      if (!returnedID || (session.sessionID && returnedID !== session.sessionID))
        throw new Error("ZCode 未返回对应会话");
      session.sessionID = returnedID;
      await session.protocol.call("session/subscribe", {
        sessionId: returnedID,
        deliveryKind: "desktop-continuous",
      });
      return session;
    } catch (error) {
      await session.close();
      throw error;
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  }
  usable(signature: string, workspace: string): boolean {
    return (
      !this.ended && this.signature === signature && (!workspace || this.workspace === workspace)
    );
  }
  async inspect(): Promise<JsonValue> {
    return this.protocol.call("session/subagents", { sessionId: this.sessionID, endedLimit: 100 });
  }
  respond(id: string, params: Params): boolean {
    return this.interaction?.respond(id, params) ?? false;
  }
  async run(
    input: Params,
    tools: LakeTool[],
    config: Params,
    signal: AbortSignal,
    emit: (event: LakeEvent) => void,
  ): Promise<string> {
    if (this.busy || this.ended) throw new Error("原生会话不能接收当前请求");
    signal.throwIfAborted();
    this.busy = true;
    this.scope.abort();
    this.scope = new AbortController();
    this.interaction = new NativeInteractions(
      text(input, "run_id", text(input, "conversation_id")),
      emit,
      this.scope.signal,
      new Set(tools.map((tool) => `mcp__lake__${tool.name}`)),
    );
    this.host.configure(tools, this.scope.signal);
    let complete: (text: string) => void = () => {},
      fail: (error: Error) => void = () => {};
    const finished = new Promise<string>((resolve, reject) => {
      complete = resolve;
      fail = reject;
    });
    void finished.catch(() => {});
    this.onEvent = (method, params) => {
      if (method === "runtime.closed") {
        fail(new Error("ZCode 运行时已退出"));
        return;
      }
      if (method === "v4/telemetry/event" && params.kind === "usage.delta") {
        const usage: Params = {};
        for (const field of [
          "inputTokens",
          "outputTokens",
          "totalTokens",
          "reasoningTokens",
          "cacheReadTokens",
          "cacheWriteTokens",
        ])
          if (Number.isSafeInteger(params[field]) && Number(params[field]) >= 0)
            usage[field] = params[field]!;
        emit({ type: "usage", ...usage });
        return;
      }
      if (method !== "session/event" || params.sessionId !== this.sessionID) return;
      const payload = object(params.payload);
      if (params.type === "turn.completed") {
        if (payload.resultType === "success") complete(text(payload, "response"));
        else fail(new Error(`ZCode 任务结束：${String(payload.resultType)}`));
      } else if (params.type === "turn.failed")
        fail(new Error("ZCode 模型任务失败，请检查模型配置与网络"));
      else if (params.type === "model.streaming" && payload.kind === "text_delta")
        emit({ type: "token", text: text(payload, "delta") });
      else if (
        ["tool.updated", "checkpoint.created", "permission.resolved"].includes(text(params, "type"))
      )
        emit({ type: "native_event", native_type: params.type, payload });
    };
    let stopping: Promise<unknown> | undefined;
    const abort = () => {
      this.scope.abort();
      stopping = this.protocol.call("session/stop", { sessionId: this.sessionID }).catch(() => {});
      fail(new Error("任务已取消"));
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      if (signal.aborted) abort();
      signal.throwIfAborted();
      emit({ type: "thinking", model: config.model, label: "ZCode Agent" });
      await this.protocol.call("session/send", {
        sessionId: this.sessionID,
        content: text(input, "content"),
        attachments: input.attachments ?? [],
        modelSelection: modelSelection(config),
      });
      const answer = await finished;
      if (!answer.trim()) throw new Error("ZCode 未返回回复");
      return answer.replaceAll(this.key.toString(), "[redacted]");
    } finally {
      signal.removeEventListener("abort", abort);
      await stopping;
      this.busy = false;
    }
  }
  async close(): Promise<void> {
    this.ended = true;
    this.scope.abort();
    this.lifetime.abort();
    await Promise.allSettled([this.protocol?.close(), this.host?.close()]);
    this.remote?.dispose();
    this.key.fill(0);
  }
}
