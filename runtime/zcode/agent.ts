import { join } from "node:path";
import { AgentRuntime, ManualPermissionBroker, createToolRegistry } from "@zcode/core";
import { InMemorySessionEventStore, modelDescriptorOf } from "@zcode/contracts";
import { AiSdkModelAdapter } from "@zcode/adapters/model";
import { createNodeExecutionAdapter } from "@zcode/adapters/exec";
import { createNodeFileSystemAdapter } from "@zcode/adapters/fs";
import { createNodeWebFetchHttpClientAdapter } from "@zcode/adapters/http";
import { createSqliteSessionStore, createNodeToolArtifactStore } from "@zcode/adapters/storage";
import type { Model, SessionEvent as ZCodeEvent, SessionId, ProjectId } from "@zcode/contracts";
import type { RegistryProviderConfig, RegistryModelConfig } from "@zcode/provider";
import {
  ProviderConfig,
  ApiKeyAccessConfig,
  ProviderApiConfig,
  ModelConfig,
} from "@zcode/provider";
import type {
  AIApproval,
  AIView,
  AICard,
  ModelProvider,
  ProviderModel,
  SessionEvent,
} from "../../web-agent/shared/contracts";
import { HttpError, id, LakeStore, now } from "./store";
import type { AgentHost, HostProfile } from "./agent-host";

type Live = {
  runtime: AgentRuntime;
  broker: ManualPermissionBroker;
  execution: ReturnType<typeof createNodeExecutionAdapter>;
  controller?: AbortController;
  completion?: Promise<void>;
  selection: string;
};
type Selection = { providerId: string; modelId: string };

export class LakeAgents {
  host?: AgentHost;
  guard?: () => void;
  private live = new Map<string, Live>();
  isRunning(sessionId: string) {
    return !!this.live.get(sessionId)?.controller;
  }
  private constructor(
    readonly store: LakeStore,
    readonly sessions: Awaited<ReturnType<typeof createSqliteSessionStore>>,
    readonly publish: (event: SessionEvent) => void,
  ) {}
  static async open(store: LakeStore, publish: (event: SessionEvent) => void) {
    const sessions = await createSqliteSessionStore({
      dbPath: join(store.data, "zcode-sessions.sqlite"),
    });
    return new LakeAgents(store, sessions, publish);
  }
  private update(sessionId: string, view: AIView, extra: Partial<SessionEvent> = {}) {
    view.totalCards = view.cards.length;
    this.store.put("views", sessionId, view);
    const session = this.store.session(sessionId);
    session.updatedAt = now();
    session.status =
      view.status === "running"
        ? "investigating"
        : view.status === "waiting_approval"
          ? "waiting_approval"
          : view.status === "failed"
            ? "failed"
            : view.status === "completed"
              ? "completed"
              : "idle";
    this.store.put("sessions", sessionId, session);
    this.publish(this.store.event(sessionId, "session", extra));
    this.host?.changed(sessionId);
  }
  private card(view: AIView, cardId: string, type: string, title = "") {
    let card = view.cards.find((card) => card.id === cardId);
    if (!card) {
      card = { id: cardId, type, title, content: "", status: "running", at: now() };
      view.cards.push(card);
    }
    return card;
  }
  private onEvent(sessionId: string, event: ZCodeEvent) {
    const view = this.store.view(sessionId);
    const payload = event.payload as Record<string, any>;
    let extra: Partial<SessionEvent> = {};
    switch (event.type) {
      case "turn_started":
        view.rootTurnId = String(event.turnId ?? id());
        view.status = "running";
        view.turnStartedAt = now();
        break;
      case "model_streaming": {
        if (!payload.delta || !["text_delta", "reasoning_delta"].includes(payload.kind)) break;
        const type = payload.kind === "reasoning_delta" ? "thinking" : "message";
        const key = String(
          payload.partId ?? `${event.turnId}:${payload.assistantMessageId ?? "reply"}:${type}`,
        );
        const card = this.card(view, key, type);
        card.content += String(payload.delta);
        extra = {
          textUpdate: {
            target: "card",
            id: key,
            content: card.content ?? "",
            cardType: type,
            at: card.at,
            rootTurnId: view.rootTurnId,
          },
        };
        break;
      }
      case "tool_call_scheduled": {
        const call = payload.toolCall ?? payload;
        const callId = String(call.id ?? call.toolCallId ?? payload.toolCallId);
        const card = this.card(
          view,
          callId,
          "operation",
          String(call.name ?? call.toolName ?? "工具"),
        );
        card.data = { call_id: callId, arguments: call.input };
        break;
      }
      case "tool_call_started":
        this.card(
          view,
          String(payload.toolCallId),
          "operation",
          String(payload.toolName ?? "工具"),
        ).status = "running";
        break;
      case "tool_call_result": {
        const card = this.card(view, String(payload.toolCallId), "operation");
        card.status = payload.result?.success === false ? "failed" : "completed";
        card.content =
          typeof payload.result?.content === "string"
            ? payload.result.content
            : JSON.stringify(payload.result?.content ?? payload.result ?? {});
        break;
      }
      case "tool_call_error": {
        const card = this.card(view, String(payload.toolCallId), "operation");
        card.status = "failed";
        card.content = String(payload.error?.message ?? "工具调用失败");
        break;
      }
      case "permission_resolved":
        view.pending = undefined;
        view.pendingApprovals = [];
        view.status = "running";
        break;
      default:
        return;
    }
    this.redactView(view);
    if (extra.textUpdate) extra.textUpdate.content = this.redact(extra.textUpdate.content);
    this.update(sessionId, view, extra);
  }
  private keys = new Set<string>();
  async prepareRedaction() {
    const selection = this.store.get<Selection>("settings", "modelSelection");
    if (selection) {
      const key = await this.store.secret(selection.providerId);
      if (key) this.keys.add(key);
    }
  }
  redact(text: string) {
    for (const key of this.keys) if (key) text = text.split(key).join("[REDACTED]");
    return text.replace(
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
      "[PRIVATE KEY REDACTED]",
    );
  }
  redactLive(text: string) {
    // A partial credential must not be persisted while its remaining bytes are in flight.
    let keep = 0;
    for (const key of this.keys) for (let size = 1; size < key.length && size <= text.length; size++)
      if (text.endsWith(key.slice(0, size))) keep = Math.max(keep, size);
    const header = text.lastIndexOf("-----");
    if (header >= 0 && /^-----(?:BEGIN [A-Z ]*)?$/.test(text.slice(header))) keep = Math.max(keep, text.length - header);
    for (let size = 1; size < 5; size++) if (text.endsWith("-----".slice(0, size))) keep = Math.max(keep, size);
    return this.redact(keep ? text.slice(0, -keep) : text) + (keep ? "[REDACTED]" : "");
  }
  private scrub<T>(value: T): T {
    if (typeof value === "string") return this.redact(value) as T;
    if (Array.isArray(value)) return value.map((item) => this.scrub(item)) as T;
    if (value && typeof value === "object" && !(value instanceof Date))
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, this.scrub(item)]),
      ) as T;
    return value;
  }
  private safeModel(base: Model, profile?: HostProfile): Model {
    const owner = this;
    return {
      ...modelDescriptorOf(base),
      bind(options) {
        return owner.safeModel(base.bind(options), profile);
      },
      async generateText(request) {
        owner.guard?.();
        profile?.beforeModel?.();
        return owner.scrub(await base.generateText(profile?.projectRequest?.(request) ?? request));
      },
      async *streamText(request) {
        owner.guard?.();
        profile?.beforeModel?.();
        // Hold a short raw tail so a credential split across provider chunks
        // cannot reach the UI, transcript or upstream session database.
        const held = new Map<string, { text: string; event: Record<string, any>; field: string }>();
        const limit = Math.max(80, ...[...owner.keys].map((key) => key.length));
        const flush = function* () {
          for (const item of held.values())
            if (item.text) yield { ...item.event, [item.field]: owner.redact(item.text) } as any;
          held.clear();
        };
        for await (const event of base.streamText(profile?.projectRequest?.(request) ?? request)) {
          const raw = event as unknown as Record<string, any>;
          const field =
            typeof raw.text === "string"
              ? "text"
              : typeof raw.delta === "string"
                ? "delta"
                : undefined;
          if (field && String(raw.type).endsWith("_delta")) {
            const key = String(raw.id ?? raw.toolCallId ?? "") + ":" + raw.type;
            const text = (held.get(key)?.text ?? "") + raw[field];
            let cut = Math.max(0, text.length - limit + 1);
            for (const secret of owner.keys) {
              let at = text.indexOf(secret);
              while (at >= 0) {
                if (at < cut && at + secret.length > cut) cut = at;
                at = text.indexOf(secret, at + 1);
              }
            }
            const privateKey = text.search(/-----BEGIN [A-Z ]*PRIVATE KEY-----/);
            if (privateKey >= 0 && privateKey < cut) cut = privateKey;
            if (cut > 0) yield owner.scrub({ ...raw, [field]: text.slice(0, cut) }) as any;
            held.set(key, { text: text.slice(cut), event: raw, field });
          } else {
            if (String(raw.type).endsWith("_end") || raw.type === "finish") yield* flush();
            yield owner.scrub(event);
          }
        }
        yield* flush();
      },
    };
  }
  private redactView(view: AIView) {
    for (const card of view.cards) {
      card.content = this.redact(card.content ?? "");
      if (card.data) card.data = JSON.parse(this.redact(JSON.stringify(card.data)));
    }
    if (view.pending) view.pending = JSON.parse(this.redact(JSON.stringify(view.pending)));
    if (view.pendingApprovals)
      view.pendingApprovals = JSON.parse(this.redact(JSON.stringify(view.pendingApprovals)));
  }
  private async model(provider: ModelProvider, model: ProviderModel, profile?: HostProfile): Promise<Model> {
    const key = await this.store.secret(provider.id);
    if (key) this.keys.add(key);
    const adapter = new AiSdkModelAdapter({ env: {}, retry: { maxAttempts: 2 } });
    const apiType =
      ["anthropic", "claude"].includes(provider.protocol)
        ? "anthropic-messages"
        : ["responses", "openai-response"].includes(provider.protocol)
          ? "openai-responses"
          : "openai-chat-completions";
    const baseURL = provider.baseURL.replace(/\/(chat\/completions|responses|messages)\/?$/, "");
    const providerConfig = new ProviderConfig({
      access: new ApiKeyAccessConfig({ apiKey: key }),
      api: new ProviderApiConfig({ type: apiType, baseUrl: baseURL }),
      group: "standard-personal",
    }) as RegistryProviderConfig;
    const modelConfig = ModelConfig.fromData({
      enabled: true,
      properties: {
        contextWindow: model.contextWindow ?? 128000,
        inputFormat: {
          supportsText: true,
          supportsImage: model.supportsImageInput,
          supportsVideo: false,
          supportsAudio: false,
          supportsPdf: false,
        },
        outputFormat: { supportsText: true },
        requiresMfjsToolSchema: false,
        supportsToolCall: true,
        supportsJsonSchemaOutput: false,
        supportsNativeWebSearch: false,
        supportsMidConversationSystem: true,
      },
      optionSpecs: {
        maxOutputTokens: {
          max: 32768,
          map:
            apiType === "openai-responses"
              ? '{"max_output_tokens": maxOutputTokens}'
              : '{"max_tokens": maxOutputTokens}',
        },
        reasoningLevel: { values: ["disabled"], map: "{}" },
      },
    }) as RegistryModelConfig;
    return this.safeModel(
      adapter.createModel({
        providerId: provider.id,
        modelId: model.name,
        providerConfig,
        modelConfig,
        options: { maxOutputTokens: 8192, reasoningLevel: "disabled" },
      }), profile,
    );
  }
  async runtime(sessionId: string) {
    const session = this.store.session(sessionId);
    const profile = this.host?.profile(sessionId);
    const selection = this.store.get<Selection>("settings", "modelSelection");
    if (!selection) throw new HttpError(409, "请先配置模型");
    const provider = this.store.require<ModelProvider>("providers", selection.providerId);
    const model = provider.models.find((model) => model.id === selection.modelId && model.enabled);
    if (!provider.enabled || !model) throw new HttpError(409, "所选模型不可用");
    const selectionKey = JSON.stringify([selection, provider, session.options, profile?.version]);
    let live = this.live.get(sessionId);
    if (live?.selection === selectionKey) return live;
    if (live?.controller) throw new HttpError(409, "请先停止当前任务，再切换模型");
    if (live) {
      await live.runtime.close();
      await live.execution.close?.();
      this.live.delete(sessionId);
    }
    const workspace = await this.store.workspace(session.projectId);
    const existingSession = await this.sessions.getSession(sessionId as SessionId);
    if (!existingSession) {
      await this.sessions.createSession({
        id: sessionId as SessionId,
        projectID: session.projectId as ProjectId,
        slug: sessionId,
        directory: workspace,
        title: session.title,
        version: "3.17.2",
        permission: profile?.permissionRules,
      });
    }
    if (existingSession && profile?.permissionRules) await this.sessions.updateSession({ id: sessionId as SessionId, permission: profile.permissionRules });
    const boundModel = await this.model(provider, model, profile);
    const broker = new ManualPermissionBroker({
      onRequest: (request) => {
        const view = this.store.view(sessionId);
        const approval: AIApproval = {
          id: request.requestId,
          call: {
            id: request.toolCallId,
            name: request.toolName,
            arguments: this.redact(JSON.stringify(request.input)),
          },
          target: request.toolName,
          risk: request.riskLevel,
          fingerprint: request.requestId,
        };
        view.pending = approval;
        view.pendingApprovals = [approval];
        view.status = "waiting_approval";
        this.update(sessionId, view);
      },
    });
    const execution = createNodeExecutionAdapter({
      outputRootDir: join(this.store.data, "tool-output"),
      processEnv: {
        PATH: process.env.PATH,
        HOME: this.store.home,
        LANG: process.env.LANG ?? "en_US.UTF-8",
      },
    });
    const filesystem = createNodeFileSystemAdapter({ textSearchEngine: "javascript" });
    const secrets = join(this.store.home, "secrets");
    const guardedFilesystem = new Proxy(filesystem, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (typeof value !== "function") return value;
        return (request: Record<string, unknown>, ...args: unknown[]) => {
          for (const field of ["path", "filePath", "directory"]) {
            const candidate = request[field];
            if (
              typeof candidate === "string" &&
              (candidate === secrets || candidate.startsWith(secrets + "/"))
            )
              throw new Error("模型工具不能读取 Lake 凭据目录");
          }
          return value.call(target, request, ...args);
        };
      },
    });
    const registry = createToolRegistry();
    for (const tool of profile?.tools ?? []) registry.register(tool);
    // ZCode bootstraps its record on first input with a cwd-derived project
    // and mode-only permissions. Keep Lake's canonical host identity and
    // session-scoped rules at the public SessionStore port on every write.
    const sessionStore = !profile ? this.sessions : new Proxy(this.sessions, {
      get: (target, property, receiver) => {
        const value = Reflect.get(target, property, receiver);
        if (typeof value !== "function") return value;
        if (property === "createSession" || property === "updateSession") return (input: any) => {
          if (input.id !== sessionId) throw new HttpError(409, "Managed runtime cannot write another session identity");
          return value.call(target, { ...input, ...(property === "createSession" ? { projectID: session.projectId } : {}),
            ...(profile.permissionRules ? { permission: profile.permissionRules } : {}) });
        };
        return value.bind(target);
      },
    });
    const runtime = new AgentRuntime(
      sessionId as SessionId,
      {
        systemPrompt: (profile?.systemPrompt ?? "You are Lake, an operations assistant. Use the available tools and report actual results. Never read credential files.") + `\n${String(session.options.userPrompt ?? "")}`,
        toolAllowlist: profile?.allowlist,
        workingDirectory: workspace,
        modelSelection: { providerId: provider.id, modelId: model.name },
        maxTurns: Number(session.options.maxSteps ?? 500),
        // Lake's versioned work_begin confirmation owns Worker plan execution.
        // The upstream mode must not become a second conflicting plan authority.
        mode: !profile && session.options.conversationMode === "plan" ? "plan" : "build",
        modelStreaming: "on",
        streamingToolExecution: "off",
        toolConcurrency: { maxConcurrency: 1 },
        titleGeneration: { enabled: false },
        targetCompletionVerification: { enabled: false },
        dynamicWorkflowEnabled: false,
        nativeSearchEnhancementsEnabled: false,
        subagents: { enabled: !profile },
        mcp: { enabled: false },
      },
      {
        sessionStore,
        toolRegistry: registry,
        eventStore: new InMemorySessionEventStore({ retention: "unbounded" }),
        modelFactory: () => boundModel,
        permissionBroker: broker,
        executionPort: execution,
        fileSystemPort: guardedFilesystem,
        httpClientPort: createNodeWebFetchHttpClientAdapter(),
        artifactStore: createNodeToolArtifactStore({
          rootDir: join(this.store.data, "artifacts"),
          imageCacheRootDir: join(this.store.data, "images"),
          videoCacheRootDir: join(this.store.data, "videos"),
        }),
        eventSink: { onSessionEvent: (event) => this.onEvent(sessionId, event) },
      },
    );
    for (const name of registry.list()) {
      const original = registry.get(name)!;
      const entry = profile?.configureTool?.(original) ?? original;
      // The public registry is shared with the executor. Interpose the Lake
      // task/operation fence at the actual handler, after any approval wait.
      registry.register({ ...entry, handler: (input, context) => { this.guard?.(); return profile?.invoke ? profile.invoke(entry, input, context) : entry.handler(input, context); } }, { silentDuplicateWarning: true });
    }
    if (existingSession)
      await (runtime as AgentRuntime & { resumeFromStore(): Promise<unknown> }).resumeFromStore();
    live = { runtime, broker, execution, selection: selectionKey };
    this.live.set(sessionId, live);
    return live;
  }
  async send(sessionId: string, text: string, options: { input?: string; recordUser?: boolean; recordAssistant?: boolean } = {}) {
    if (!text.trim()) throw new HttpError(400, "消息不能为空");
    if (this.store.session(sessionId).workspaceRole === "legacy") throw new HttpError(409, "旧会话只读，不恢复或重放历史执行");
    const live = await this.runtime(sessionId);
    if (live.controller) throw new HttpError(409, "当前任务正在运行，请等待完成或停止后发送");
    const session = this.store.session(sessionId);
    if (session.title === "新对话") {
      session.title = text.slice(0, 40);
      this.store.put("sessions", sessionId, session);
    }
    if (options.recordUser !== false) this.store.addMessage(sessionId, "user", text);
    const view = this.store.view(sessionId);
    view.status = "running";
    view.replyStatus = "running";
    view.turns++;
    view.turnStartedAt = now();
    view.turnFinishedAt = undefined;
    this.update(sessionId, view);
    const controller = new AbortController();
    live.controller = controller;
    live.completion = (async () => {
      try {
        const result = await live.runtime.executeTurn(options.input ?? text, undefined, {
          abortSignal: controller.signal,
        });
        const final = this.store.view(sessionId);
        if (result.response) {
          const matching = [...final.cards]
            .reverse()
            .find((card) => card.type === "message" && card.status === "running");
          if (matching) matching.content = this.redact(result.response);
          else
            final.cards.push({
              id: id(),
              type: "message",
              content: this.redact(result.response),
              status: "completed",
              at: now(),
            });
          if (options.recordAssistant !== false) this.store.addMessage(sessionId, "assistant", this.redact(result.response));
        }
        final.status = controller.signal.aborted ? "cancelled" : "completed";
        this.update(sessionId, final);
      } catch (error) {
        const final = this.store.view(sessionId);
        final.status = controller.signal.aborted ? "cancelled" : "failed";
        if (!controller.signal.aborted)
          final.cards.push({
            id: id(),
            type: "error",
            content: this.redact(error instanceof Error ? error.message : String(error)),
            status: "failed",
            at: now(),
          });
        this.update(sessionId, final);
      } finally {
        const final = this.store.view(sessionId);
        final.pending = undefined;
        final.pendingApprovals = [];
        final.turnFinishedAt = now();
        final.replyStatus = final.status;
        for (const card of final.cards)
          if (["running", "pending"].includes(card.status)) card.status = final.status;
        this.update(sessionId, final);
        live.controller = undefined;
        this.host?.settled(sessionId);
      }
    })();
    return {};
  }
  async wait(sessionId: string) { await this.live.get(sessionId)?.completion; }
  async steer(sessionId: string, input: string, inputId: string) {
    const live = this.live.get(sessionId);
    if (!live?.controller) return false;
    const result = await live.runtime.steerTurn({ input, pendingInputId: inputId, delivery: "guide" });
    return result.kind === "queued";
  }
  decision(sessionId: string, approvalId: string, accept: boolean) {
    const live = this.live.get(sessionId);
    if (
      !live ||
      !live.broker.resolvePermission(approvalId, {
        decision: accept ? "allow" : "deny",
        resolvedAt: new Date(),
      })
    )
      throw new HttpError(409, "审批已失效");
  }
  async abort(sessionId: string) {
    const live = this.live.get(sessionId);
    live?.controller?.abort(new Error("用户停止了任务"));
    if (live?.completion) await live.completion;
  }
  async close() {
    for (const live of this.live.values()) live.controller?.abort(new Error("Lake 正在退出"));
    await Promise.allSettled(
      [...this.live.values()].map(async (live) => {
        await live.completion;
        await live.runtime.close();
        await live.execution.close?.();
      }),
    );
    this.sessions.close();
  }
}
