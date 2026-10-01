import { createHash } from "node:crypto";
import type { AgentPort, LakeTool } from "../../domain/agent.js";
import type { LakeEvent, LakeRuntimeOptions } from "../../domain/protocol.js";
import { object, text, type Params } from "../../domain/validation.js";
import { readModelConfig, readSettings, selectedProvider } from "../config/files.js";
import { FileVault } from "../vault.js";
import { inspectNativeSubagents, subagentRows } from "./inspect.js";
import type { NativeRemoteSession } from "../native/remote.js";
import { nativeExtensionSignature } from "./extensions.js";
import { NativeSession } from "./session.js";

export class LakeZCodeAgent implements AgentPort {
  private readonly opening = new Map<string, AbortController>();
  private readonly owners = new Map<string, NativeSession>();
  constructor(
    private readonly root: string,
    private readonly vault: FileVault,
    private readonly options: LakeRuntimeOptions,
    private readonly remote?: (id: string, signal: AbortSignal) => Promise<NativeRemoteSession>,
  ) {}
  async respond(id: string, params: Params): Promise<boolean> {
    for (const session of this.owners.values()) if (session.respond(id, params)) return true;
    return false;
  }
  async inspect(input: Params) {
    const live = this.owners.get(text(input, "id"));
    return live
      ? subagentRows(await live.inspect(), text(input, "id"))
      : inspectNativeSubagents(this.root, this.options, input);
  }
  async run(
    input: Params,
    tools: LakeTool[],
    signal: AbortSignal,
    emit: (event: LakeEvent) => void,
  ): Promise<string> {
    const config = await readModelConfig(this.root);
    if (typeof input.max_output_tokens === "number")
      config.max_output_tokens = Math.min(
        Number(config.max_output_tokens ?? 4096),
        input.max_output_tokens,
      );
    if (input.model) {
      const provider = object(config.model_catalog)[text(input, "model")];
      if (!provider) throw new Error("模型未登记");
      config.model = input.model;
      config.model_provider = provider;
    }
    selectedProvider(config);
    const baseOwner = text(input, "native_session_id", text(input, "conversation_id"));
    if (!baseOwner) throw new Error("LAKE 会话需要稳定 ID");
    // A report uses native session restrictions and an imported snapshot of the current Lake history.
    const owner =
        input.review_only === true ? `${baseOwner}-report-${text(input, "run_id")}` : baseOwner,
      workspace = text(input, "workspace");
    const remote = input.remote_workspace_id
      ? await this.remote?.(text(input, "remote_workspace_id"), signal)
      : undefined;
    if (input.remote_workspace_id && !remote)
      throw new Error("原生远程宿主不可用，不能在本机执行远程任务");
    const actualWorkspace = remote?.workspace ?? workspace;
    const key = await this.vault.load("model", text(config, "model_provider"));
    const signature = createHash("sha256")
      .update(
        JSON.stringify([
          config,
          await readSettings(this.root),
          remote?.signature ?? "",
          actualWorkspace,
          nativeExtensionSignature(actualWorkspace, this.root),
        ]),
      )
      .update(key)
      .digest("hex");
    let session = this.owners.get(owner);
    if (session && !session.usable(signature, actualWorkspace)) {
      await session.close();
      this.owners.delete(owner);
      session = undefined;
    }
    if (session) key.fill(0);
    else {
      if (this.opening.has(owner)) {
        key.fill(0);
        throw new Error("原生会话连接正在建立");
      }
      const controller = new AbortController(),
        abort = () => controller.abort();
      this.opening.set(owner, controller);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      try {
        session = await NativeSession.open(
          this.root,
          owner,
          actualWorkspace,
          signature,
          key,
          config,
          input,
          tools,
          this.options,
          remote,
          controller.signal,
        );
        controller.signal.throwIfAborted();
        this.owners.set(owner, session);
      } catch (error) {
        await session?.close();
        key.fill(0);
        throw error;
      } finally {
        signal.removeEventListener("abort", abort);
        this.opening.delete(owner);
      }
    }
    try {
      return await session.run(input, tools, config, signal, emit);
    } finally {
      if (input.review_only === true) {
        await session.close();
        this.owners.delete(owner);
      }
    }
  }
  async close(): Promise<void> {
    for (const controller of this.opening.values()) controller.abort();
    await Promise.allSettled([...this.owners.values()].map((session) => session.close()));
    this.owners.clear();
  }
}
