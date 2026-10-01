import { mkdtemp, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AgentPort, LakeTool } from "../../domain/agent.js";
import type { LakeEvent, LakeRuntimeOptions } from "../../domain/protocol.js";
import { object, text, type Params } from "../../domain/validation.js";
import { readModelConfig, selectedProvider } from "../config/files.js";
import { FileVault } from "../vault.js";
import { ZCodeProtocol } from "./protocol.js";
import { createAgentHost } from "./host.js";
import { DENIED_NATIVE_TOOLS, modelSelection, prepareAgentConfig } from "./config.js";

export class LakeZCodeAgent implements AgentPort {
  constructor(private readonly root: string, private readonly vault: FileVault, private readonly options: LakeRuntimeOptions) {}
  async run(input: Params, tools: LakeTool[], signal: AbortSignal, emit: (event: LakeEvent) => void): Promise<string> {
    const config = await readModelConfig(this.root);
    if (input.model) {
      const provider = object(config.model_catalog)[text(input, "model")];
      if (!provider) throw new Error("模型未登记"); config.model = input.model; config.model_provider = provider;
    }
    const provider = selectedProvider(config), key = await this.vault.load("model", text(config, "model_provider"));
    let directory = "";
    const cli = this.options.cliPath ?? process.env.LAKE_ZCODE_CLI ?? join(dirname(process.execPath), "zcode.cjs");
    const node = this.options.nodePath ?? process.env.LAKE_ZCODE_NODE ?? process.execPath;
    let host: Awaited<ReturnType<typeof createAgentHost>> | undefined, protocol: ZCodeProtocol | undefined;
    const controller = new AbortController(), abort = () => controller.abort(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    try {
      directory = await mkdtemp(join(this.root, ".zcode-turn-"));
      if (signal.aborted) abort(); controller.signal.throwIfAborted();
      host = await createAgentHost({ tools, apiKey: key, provider, signal: controller.signal });
      await prepareAgentConfig(directory, cli, config, host.url, host.token);
      let complete: (value: string) => void = () => {}, fail: (error: Error) => void = () => {}, sessionID = "";
      const finished = new Promise<string>((resolve, reject) => { complete = resolve; fail = reject; });
      // Register rejection handling before a protocol startup error can reject the turn.
      void finished.catch(() => {});
      const turnAbort = () => fail(new Error("任务已取消"));
      controller.signal.addEventListener("abort", turnAbort, { once: true });
      protocol = new ZCodeProtocol(node, cli, directory, controller.signal, (method, params) => {
        if (method === "runtime.closed") { fail(new Error("ZCode 在任务完成前退出")); return; }
        if (method === "v4/telemetry/event" && params.kind === "usage.delta") { emit({ type: "usage", ...params }); return; }
        if (method !== "session/event" || params.sessionId !== sessionID) return;
        const payload = object(params.payload);
        if (params.type === "turn.completed") {
          if (payload.resultType !== "success") fail(new Error(`ZCode 任务结束：${String(payload.resultType)}`));
          else complete(text(payload, "response"));
        } else if (params.type === "turn.failed" || params.type === "turn.error") fail(new Error("ZCode 模型任务失败，请检查模型配置与网络"));
        else if (params.type === "assistant.message.delta" && payload.text) emit({ type: "token", text: text(payload, "text") });
      });
      const model = modelSelection(config);
      const created = object(await protocol.call("session/create", {
        workspace: { workspacePath: directory, workspaceKey: directory }, mode: "build", model,
        titleGenerationEnabled: false,
        mcpServers: [{ name: "lake", type: "http", url: host.url + "/mcp", headers: [{ name: "Authorization", value: "Bearer " + host.token }], protocolVersion: "legacy", timeoutMs: 3_600_000 }],
        toolAllowlist: tools.map(tool => `mcp__lake__${tool.name}`), toolDenylist: DENIED_NATIVE_TOOLS,
      }));
      sessionID = text(object(created.session), "sessionId");
      if (!sessionID) throw new Error("ZCode 未返回有效会话");
      await protocol.call("session/subscribe", { sessionId: sessionID, deliveryKind: "desktop-continuous" });
      emit({ type: "thinking", model: config.model, label: "ZCode Agent" });
      await protocol.call("session/send", { sessionId: sessionID, content: text(input, "content"), attachments: input.attachments ?? [], modelSelection: model, modelExecution: { selectionScope: "execution", memoryExtraction: "skip" } });
      const answer = await finished;
      controller.signal.removeEventListener("abort", turnAbort);
      if (!answer.trim()) throw new Error("ZCode 未返回回复");
      return answer.replaceAll(key.toString(), "[redacted]");
    } finally {
      signal.removeEventListener("abort", abort); controller.abort();
      await Promise.allSettled([protocol?.close(), host?.close()]); key.fill(0);
      if (directory) await rm(directory, { recursive: true, force: true });
    }
  }
}
