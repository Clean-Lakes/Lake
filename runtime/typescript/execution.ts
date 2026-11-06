import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type {
  ExecutionPort,
  ExecutionRequest,
  ExecutionResult,
  ExecutionRunOptions,
  BackgroundExecutionSnapshot,
} from "./sdk";
import type { Resource } from "../../web-agent/shared/contracts";
import type { LakeSSH } from "./ssh";
import type { LakeSecurity } from "./security";
import type { HostCommandView } from '../../web-agent/shared/contracts';
import type { Operation } from './tasks';
import { HttpError, LakeStore, id, now } from "./store";
import { digest, text } from "./tasks";
import { commandPolicy } from "../../web-agent/shared/command-policy";

const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
const outputLimit = 256 * 1024;
export type ShellInput = {
  command: string;
  asset_ref?: string;
  configuration_revision?: string;
  cwd?: string;
  timeout?: number;
  description?: string;
  run_in_background?: boolean;
  dangerouslyDisableSandbox?: boolean;
};
export type ShellActor = {
  sessionId: string;
  taskId: string;
  workerId: string;
  generation: number;
  guard: () => void;
};
export type ShellPlan = {
  resource: Resource;
  revision: string;
  resourceRevision: number;
  command: string;
  cwd?: string;
  readOnly: boolean;
  policy: "allow" | "ask";
  risk: "readonly" | "write" | "dangerous";
};
type CommandRecord = {
  command?: string;
  stdoutTail?: string;
  stderrTail?: string;
  stopRequestedAt?: string;
  id: string;
  taskId: string;
  workerId: string;
  sessionId: string;
  generation: number;
  resourceId: string;
  resourceRevision: number;
  configurationRevision: string;
  commandHash: string;
  readOnly: boolean;
  status: string;
  startedAt: string;
  finishedAt?: string;
  result?: ExecutionResult;
  backgroundTaskId?: string;
  outputPath?: string;
};
type Live = {
  record: CommandRecord;
  actor: ShellActor;
  controller: AbortController;
  promise: Promise<ExecutionResult>;
  backgroundTaskId?: string;
  timer?: ReturnType<typeof setInterval>;
  cancel?: () => Promise<unknown>;
};

/** Resource-bound public ExecutionPort. The SDK owns Bash, scheduling and model loops. */
export class LakeExecution {
  private lives = new Map<string, Live>();
  private handles = new Map<string, Live>();
  private bases = new WeakMap<ExecutionPort, any>();
  private waiters = new Map<string, Set<(record: CommandRecord) => void>>();
  constructor(
    readonly store: LakeStore,
    readonly security: LakeSecurity,
    readonly ssh: LakeSSH,
    readonly scrub: (value: string) => string,
  ) {
    for (const record of store.list<CommandRecord>("commandExecutions"))
      if (record.status === "running") {
        record.status = "unknown";
        record.finishedAt = now();
        store.put("commandExecutions", record.id, record);
      }
  }
  revision(resource: Resource) {
    return resource.kind === "ssh"
      ? this.ssh.revision(resource)
      : digest([
          resource.id,
          resource.projectId,
          resource.kind,
          resource.settings,
          this.store.get("resourceRevisions", resource.id),
          this.store.get("projectSettings", resource.projectId),
        ]);
  }
  plan(projectId: string, input: ShellInput): ShellPlan {
    const resource = input.asset_ref
      ? this.store.require<Resource>(
          "resources",
          text(input.asset_ref, "asset_ref", 200),
        )
      : this.store
          .catalog()
          .resources.find(
            (resource) =>
              resource.projectId === projectId &&
              resource.kind === "local" &&
              resource.status === "available",
          );
    if (
      !resource ||
      resource.projectId !== projectId ||
      !["local", "ssh"].includes(resource.kind) ||
      resource.status !== "available"
    )
      throw new HttpError(403, "Shell 需要当前项目的可用本机或 SSH 资源");
    const command = text(input.command, "command", 64000),
      revision = this.revision(resource),
      policy = commandPolicy(command);
    if (input.asset_ref && input.configuration_revision !== revision)
      throw new HttpError(409, "Shell 连接配置已变化，请重新读取资源目录");
    if (input.dangerouslyDisableSandbox)
      throw new HttpError(403, "不能通过模型参数关闭 Lake 秘密保护");
    if (
      input.timeout !== undefined &&
      (!Number.isFinite(input.timeout) ||
        input.timeout < 1 ||
        input.timeout > 600000)
    )
      throw new HttpError(400, "Shell timeout 必须在 1–600000 毫秒内");
    if (
      input.cwd !== undefined &&
      (typeof input.cwd !== "string" ||
        !input.cwd.startsWith("/") ||
        /[\0\r\n]/.test(input.cwd) ||
        input.cwd.length > 4096)
    )
      throw new HttpError(400, "Shell cwd 需要准确的绝对路径");
    // Authentication stays in the host. Never request private key/Keychain contents.
    if (
      /(?:\.lake(?:-dev)?\/secrets|\.ssh\/(?:id_|[^\s]*\.pem)|BEGIN [A-Z ]*PRIVATE KEY|\bsecurity\s+(?:find-|dump-|export)|\/Library\/Keychains)/i.test(
        command,
      )
    )
      throw new HttpError(403, "Shell 不允许读取或导出宿主认证凭据");
    const readOnly = policy.risk === "readonly";
    return {
      resource,
      revision,
      resourceRevision:
        this.store.get<number>("resourceRevisions", resource.id) ?? 1,
      command: readOnly ? policy.safeCommand! : command,
      cwd: input.cwd,
      readOnly,
      policy: this.security.command(projectId, resource.id, readOnly),
      risk: policy.risk,
    };
  }
  revalidate(record: CommandRecord) {
    const resource = this.store.require<Resource>(
      "resources",
      record.resourceId,
    );
    this.security.command(
      this.store.session(record.sessionId).projectId,
      resource.id,
      record.readOnly,
    );
    if (
      this.revision(resource) !== record.configurationRevision ||
      (this.store.get<number>("resourceRevisions", resource.id) ?? 1) !==
        record.resourceRevision
    )
      throw new HttpError(409, "Shell 资源配置或凭据已变化");
  }
  /** UI projection uses both immutable operation ownership and command identity. */
  views(sessionId: string, taskId: string): HostCommandView[] {
    const projectId = this.store.session(sessionId).projectId;
    const operations = this.store.list<Operation>('superOperations').filter(op => op.projectId === projectId && op.sessionId === sessionId && op.goalId === taskId && op.commandExecutionId);
    return operations.flatMap(op => {
      const record = this.store.get<CommandRecord>('commandExecutions', op.commandExecutionId!);
      if (!record || record.sessionId !== sessionId || record.taskId !== taskId || record.generation !== op.generation || record.resourceId !== op.resourceId || record.resourceRevision !== op.resourceRevision || record.configurationRevision !== op.hostConfigurationHash) return [];
      const live = this.lives.get(record.id);
      let canStop = false;
      if (live && record.status === 'running' && !record.stopRequestedAt) {
        try { live.actor.guard(); this.revalidate(record); canStop = true; } catch { /* Historical or fenced command. */ }
      }
      return [{ id: record.id, operationId: op.id, taskId, sessionId, generation: record.generation, resourceId: record.resourceId,
        command: this.scrub(record.command ?? ''), output: this.scrub(record.result ? [record.result.stdout?.text, record.result.stderr?.text].filter(Boolean).join('\n') : [record.stdoutTail, record.stderrTail].filter(Boolean).join('\n')),
        exitCode: record.result?.exitCode ?? null, status: record.status, canStop, stopRequestedAt: record.stopRequestedAt,
        startedAt: record.startedAt, finishedAt: record.finishedAt }];
    });
  }
  interrupt(sessionId: string, executionId: string, generation: unknown) {
    const live = this.lives.get(executionId);
    if (!live || live.record.sessionId !== sessionId || live.record.generation !== generation || live.record.status !== 'running')
      throw new HttpError(409, '当前命令已结束或执行版本已变化');
    live.actor.guard(); this.revalidate(live.record);
    if (!this.views(sessionId, live.record.taskId).some(row => row.id === executionId)) throw new HttpError(409, '缺少原任务命令回执');
    live.record.stopRequestedAt ??= now();
    this.store.put('commandExecutions', executionId, live.record);
    live.controller.abort();
    void live.cancel?.().catch(() => {});
    return { requested: true };
  }
  evidence(executionId: string, taskId: string, generation: number) {
    const record = this.store.require<CommandRecord>(
      "commandExecutions",
      executionId,
    );
    if (record.taskId !== taskId || record.generation !== generation)
      throw new HttpError(409, "Shell 结果不属于原任务与执行版本");
    this.revalidate(record);
    if (record.status !== "completed" || record.result?.exitCode !== 0)
      throw new HttpError(409, "Shell 尚未取得当前有效的成功退出回执");
    return record;
  }
  whenSettled(executionId: string): Promise<CommandRecord> {
    const record = this.store.get<CommandRecord>(
      "commandExecutions",
      executionId,
    );
    if (record && record.status !== "running") return Promise.resolve(record);
    return new Promise((resolve) => {
      const set = this.waiters.get(executionId) ?? new Set();
      set.add(resolve);
      this.waiters.set(executionId, set);
    });
  }
  canReadOutput(taskId: string, path: string) {
    return this.store
      .list<CommandRecord>("commandExecutions")
      .some(
        (record) =>
          record.taskId === taskId &&
          [
            record.outputPath,
            record.result?.stdout.artifactPath,
            record.result?.stderr.artifactPath,
          ].some(
            (candidate) => candidate && resolve(candidate) === resolve(path),
          ),
      );
  }
  executionId(actor: ShellActor, callId: string) {
    return digest([actor.taskId, actor.generation, callId]);
  }
  runtime(base: ExecutionPort, sessionId: string): ExecutionPort {
    const owner = this;
    const proxy = new Proxy(base, {
      get(target, key) {
        if (key === "getBackgroundTask")
          return async (taskId: string) => owner.snapshot(sessionId, taskId);
        if (key === "waitForBackgroundTask")
          return async (taskId: string, options?: { signal?: AbortSignal }) => {
            const live = owner.owned(sessionId, taskId);
            if (!live) return;
            if (options?.signal?.aborted)
              throw new HttpError(409, "后台命令读取已取消");
            const abort = new Promise<never>((_, reject) =>
              options?.signal?.addEventListener(
                "abort",
                () => reject(new HttpError(409, "后台命令读取已取消")),
                { once: true },
              ),
            );
            await Promise.race([live.promise, abort]);
            return owner.snapshot(sessionId, taskId);
          };
        if (key === "cancelBackgroundTask")
          return async (taskId: string) => {
            const live = owner.owned(sessionId, taskId);
            if (!live) return;
            live.controller.abort();
            await live.cancel?.();
            await live.promise;
            return owner.snapshot(sessionId, taskId);
          };
        if (key === "readBackgroundBashOutput")
          return async (taskId: string) => {
            const snapshot = await owner.snapshot(sessionId, taskId);
            if (!snapshot) return { kind: "unavailable", workId: taskId };
            const result = snapshot.result,
              output = owner.scrub(
                (result?.stdout.text ?? snapshot.stdoutTail ?? "") +
                  (result?.stderr.text ?? snapshot.stderrTail ?? ""),
              );
            return {
              kind: "output",
              workId: taskId,
              status: snapshot.status,
              output: output.slice(-8192),
              truncated: output.length > 8192,
              outputPath: snapshot.outputPath ?? "",
            };
          };
        if (key === "close")
          return async () => {
            await Promise.all(
              [...owner.lives.values()]
                .filter((live) => live.actor.sessionId === sessionId)
                .map(async (live) => {
                  live.controller.abort();
                  await live.cancel?.();
                  await live.promise;
                }),
            );
            for (const [key, live] of owner.handles)
              if (live.actor.sessionId === sessionId) owner.handles.delete(key);
            await target.close?.();
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    this.bases.set(proxy, base);
    return proxy;
  }
  private owned(sessionId: string, taskId: string) {
    const live = this.handles.get(taskId);
    if (live && live.actor.sessionId !== sessionId)
      throw new HttpError(403, "后台命令不属于当前执行会话");
    return live;
  }
  private async snapshot(
    sessionId: string,
    taskId: string,
  ): Promise<BackgroundExecutionSnapshot | undefined> {
    const live = this.owned(sessionId, taskId);
    if (!live) return;
    this.revalidate(live.record);
    const r = this.store.require<CommandRecord>(
        "commandExecutions",
        live.record.id,
      ),
      result = r.result
        ? {
            ...r.result,
            startedAt: new Date(r.result.startedAt),
            completedAt: new Date(r.result.completedAt),
          }
        : undefined;
    return {
      taskId,
      status: r.status as any,
      startedAt: new Date(r.startedAt),
      ...(r.finishedAt ? { completedAt: new Date(r.finishedAt) } : {}),
      result,
      stdoutTail: result?.stdout.text,
      stderrTail: result?.stderr.text,
      outputPath: result?.stdout.artifactPath,
    };
  }
  bind(
    runtime: ExecutionPort,
    actor: ShellActor,
    plan: ShellPlan,
    callId: string,
  ): ExecutionPort {
    const owner = this,
      base = this.bases.get(runtime) ?? runtime;
    const run = async (
      request: ExecutionRequest,
      options: ExecutionRunOptions = {},
      lifecycle?: { mode: string },
    ) => {
      actor.guard();
      owner.security.command(
        plan.resource.projectId,
        plan.resource.id,
        plan.readOnly,
      );
      if (
        owner.revision(owner.store.require("resources", plan.resource.id)) !==
        plan.revision
      )
        throw new HttpError(409, "Shell 配置已变化");
      const executionId = owner.executionId(actor, callId),
        controller = new AbortController(),
        signal = AbortSignal.any([
          options.signal ?? new AbortController().signal,
          controller.signal,
        ]);
      if (
        owner.lives.has(executionId) ||
        owner.store.get("commandExecutions", executionId)
      )
        throw new HttpError(409, "原 Shell 操作不能重新派发");
      if(owner.store.list<CommandRecord>('commandExecutions').some(prior => prior.sessionId === actor.sessionId && prior.taskId === actor.taskId && prior.generation === actor.generation && prior.resourceId === plan.resource.id && prior.commandHash === digest(plan.command) && prior.stopRequestedAt))
        throw new HttpError(409, '用户已终止此命令；本轮不得自动重试，请等待新的用户要求');
      const record: CommandRecord = {
        command: owner.scrub(plan.command),
        id: executionId,
        taskId: actor.taskId,
        workerId: actor.workerId,
        sessionId: actor.sessionId,
        generation: actor.generation,
        resourceId: plan.resource.id,
        resourceRevision: plan.resourceRevision,
        configurationRevision: plan.revision,
        commandHash: digest(plan.command),
        readOnly: plan.readOnly,
        status: "running",
        startedAt: now(),
      };
      owner.store.put("commandExecutions", record.id, record);
      let complete!: (result: ExecutionResult) => void;
      const promise = new Promise<ExecutionResult>(
        (resolve) => (complete = resolve),
      );
      const live: Live = { record, actor, controller, promise };
      owner.lives.set(record.id, live);
      live.timer = setInterval(() => {
        try {
          actor.guard();
          owner.revalidate(record);
          if (Date.now() - Date.parse(record.startedAt) >= 600000)
            throw new HttpError(409, "命令达到十分钟执行上限");
        } catch {
          controller.abort();
          void live.cancel?.();
        }
      }, 200);
      live.timer.unref();
      const finish = (result: ExecutionResult) => {
        clearInterval(live.timer);
        result = JSON.parse(owner.scrub(JSON.stringify(result)));
        result.startedAt = new Date(result.startedAt);
        result.completedAt = new Date(result.completedAt);
        record.result = result;
        record.status = result.status;
        record.finishedAt = now();
        owner.store.put("commandExecutions", record.id, record);
        owner.lives.delete(record.id);
        complete(result);
        for (const waiter of owner.waiters.get(record.id) ?? []) waiter(record);
        owner.waiters.delete(record.id);
        return result;
      };
      try {
        const requestOptions = {
          ...options,
          signal,
          onEvent: async (event: any) => {
            const safe = JSON.parse(owner.scrub(JSON.stringify(event)));
            if (safe.type === 'progress' && owner.lives.get(record.id) === live) {
              if (typeof safe.stdoutTail === 'string') record.stdoutTail = safe.stdoutTail.slice(-8192);
              if (typeof safe.stderrTail === 'string') record.stderrTail = safe.stderrTail.slice(-8192);
              owner.store.put('commandExecutions', record.id, record);
            }
            if (safe.timestamp) safe.timestamp = new Date(safe.timestamp);
            await options.onEvent?.(safe);
          },
        };
        if (plan.resource.kind === "ssh") {
          const output = owner.remote(
            actor,
            plan,
            {
              ...request,
              timeoutMs: lifecycle ? 600000 : request.timeoutMs || 600000,
            },
            requestOptions,
          );
          const taskId = "ssh_" + id();
          live.backgroundTaskId = taskId;
          record.backgroundTaskId = taskId;
          owner.handles.set(taskId, live);
          const work = output.then(finish, (error) =>
            finish(owner.failure(error, record.startedAt, signal)),
          );
          const backgrounded = () => {
            owner.store.put("commandExecutions", record.id, record);
            return {
              kind: "backgrounded",
              task: {
                taskId,
                status: "running",
                startedAt: new Date(record.startedAt),
              },
            };
          };
          if (lifecycle?.mode === "explicit") return backgrounded();
          if (
            lifecycle?.mode === "auto_on_timeout" &&
            (request.timeoutMs ?? 0) > 0
          ) {
            let promotion: ReturnType<typeof setTimeout> | undefined;
            try {
              return await Promise.race([
                work.then((result) => ({ kind: "foreground", result })),
                new Promise<ReturnType<typeof backgrounded>>((resolve) => {
                  promotion = setTimeout(
                    () => resolve(backgrounded()),
                    request.timeoutMs,
                  );
                }),
              ]);
            } finally {
              clearTimeout(promotion);
            }
          }
          return { kind: "foreground", result: await work };
        }
        const local = await owner.localRequest(actor, plan, request);
        actor.guard();
        owner.revalidate(record);
        // Keep the upstream background lifecycle and registry, with the same resource fence.
        if (lifecycle && base.runBashWithBackgroundLifecycle) {
          const started = await base.runBashWithBackgroundLifecycle(
            local,
            lifecycle,
            requestOptions,
          );
          if (started.kind === "foreground")
            return { kind: "foreground", result: finish(started.result) };
          const taskId = started.task.taskId;
          live.backgroundTaskId = taskId;
          record.backgroundTaskId = taskId;
          record.outputPath = started.task.outputPath;
          owner.handles.set(taskId, live);
          owner.store.put("commandExecutions", record.id, record);
          live.cancel = () => base.cancelBackgroundTask?.(taskId);
          void (async () => {
            let snapshot: BackgroundExecutionSnapshot | undefined;
            do {
              snapshot = await base.getBackgroundTask(taskId);
              if (snapshot?.status !== "running") break;
              await new Promise((resolve) => setTimeout(resolve, 40));
            } while (!signal.aborted);
            if (signal.aborted) await live.cancel?.();
            snapshot = await base.getBackgroundTask(taskId);
            finish(
              snapshot?.result ??
                owner.failure(
                  new Error("后台命令未返回完整结果"),
                  record.startedAt,
                  signal,
                ),
            );
          })().catch((error) =>
            finish(owner.failure(error, record.startedAt, signal)),
          );
          return started;
        }
        return {
          kind: "foreground",
          result: finish(await base.run(local, requestOptions)),
        };
      } catch (error) {
        return {
          kind: "foreground",
          result: finish(owner.failure(error, record.startedAt, signal)),
        };
      }
    };
    return {
      run: async (request, options) => (await run(request, options)).result!,
      runBashWithBackgroundLifecycle: (
        request: ExecutionRequest,
        lifecycle: { mode: string },
        options?: ExecutionRunOptions,
      ) => run(request, options, lifecycle),
      getBackgroundTask: runtime.getBackgroundTask?.bind(runtime),
      cancelBackgroundTask: runtime.cancelBackgroundTask?.bind(runtime),
      readBackgroundBashOutput: runtime.readBackgroundBashOutput?.bind(runtime),
    } as ExecutionPort;
  }
  private failure(
    error: unknown,
    startedAt: string,
    signal: AbortSignal,
  ): ExecutionResult {
    const message = this.scrub(
      error instanceof Error ? error.message : String(error),
    );
    return {
      status: signal.aborted ? "cancelled" : "spawn_error",
      stdout: { text: "", bytes: 0, truncated: false },
      stderr: {
        text: message,
        bytes: Buffer.byteLength(message),
        truncated: false,
      },
      durationMs: Date.now() - Date.parse(startedAt),
      timedOut: false,
      cancelled: signal.aborted,
      startedAt: new Date(startedAt),
      completedAt: new Date(),
    };
  }
  private async localRequest(
    actor: ShellActor,
    plan: ShellPlan,
    request: ExecutionRequest,
  ): Promise<ExecutionRequest> {
    if (process.platform !== "darwin" || !existsSync("/usr/bin/sandbox-exec"))
      throw new HttpError(501, "此平台尚未配置本机 Shell 的凭据隔离执行器");
    const workspace = await this.store.workspace(plan.resource.projectId),
      output = join(this.store.data, "tool-output", actor.sessionId);
    const literal = (value: string) => JSON.stringify(resolve(value));
    const profile = `(version 1)(allow default)(deny file-read* file-write* (require-all (subpath ${literal(this.store.home)}) (require-not (subpath ${literal(workspace)})) (require-not (subpath ${literal(output)}))))(deny file-read* file-write* (subpath ${literal(join(homedir(), ".lake"))}) (subpath ${literal(join(homedir(), ".ssh"))}) (subpath ${literal(join(homedir(), "Library/Keychains"))}) (subpath "/Library/Keychains"))(deny process-exec (literal "/usr/bin/security"))`;
    const command = `/usr/bin/sandbox-exec -p ${quote(profile)} /bin/bash --noprofile --norc -c ${quote(plan.command)}`;
    return {
      ...request,
      cwd: plan.cwd ?? request.cwd ?? workspace,
      command: { mode: "shell", command, shellProfile: "posix-bash" },
      env: {
        base: "empty",
        set: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          HOME: workspace,
          LANG: "en_US.UTF-8",
        },
      },
      outputLimit: {
        ...request.outputLimit,
        maxPersistedBytes: outputLimit,
        maxArtifactBytes: outputLimit,
        killProcessOnPersistedLimit: true,
      },
    };
  }
  private async remote(
    actor: ShellActor,
    plan: ShellPlan,
    request: ExecutionRequest,
    options: ExecutionRunOptions,
  ): Promise<ExecutionResult> {
    const startedAt = new Date(),
      signal = options.signal ?? new AbortController().signal,
      connection = await this.ssh.connect(
        actor.sessionId,
        plan.resource,
        signal,
      );
    try {
      return await new Promise((resolve, reject) => {
        let channel: any,
          stdout = Buffer.alloc(0),
          stderr = Buffer.alloc(0),
          exitCode: number | undefined,
          done = false,
          timedOut = false;
        const finish = (error?: unknown) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          signal.removeEventListener("abort", abort);
          channel?.close();
          if (error) {
            reject(error);
            return;
          }
          const completedAt = new Date();
          resolve({
            status: signal.aborted
              ? "cancelled"
              : timedOut
                ? "timed_out"
                : exitCode === 0
                  ? "completed"
                  : "failed",
            exitCode,
            stdout: {
              text: this.scrub(stdout.toString("utf8")),
              bytes: stdout.length,
              truncated: false,
            },
            stderr: {
              text: this.scrub(stderr.toString("utf8")),
              bytes: stderr.length,
              truncated: false,
            },
            durationMs: +completedAt - +startedAt,
            timedOut,
            cancelled: signal.aborted,
            startedAt,
            completedAt,
          });
        };
        const abort = () => finish();
        const timer = setTimeout(
          () => {
            timedOut = true;
            finish();
          },
          Math.min(request.timeoutMs ?? 120000, 600000),
        );
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) {
          finish();
          return;
        }
        actor.guard();
        this.revalidate({
          sessionId: actor.sessionId,
          resourceId: plan.resource.id,
          configurationRevision: plan.revision,
          resourceRevision: plan.resourceRevision,
          readOnly: plan.readOnly,
        } as CommandRecord);
        const command =
          (plan.cwd ? `cd -- ${quote(plan.cwd)} && ` : "") +
          `/bin/bash --noprofile --norc -c ${quote(plan.command)}`;
        connection.exec(command, (error: any, stream: any) => {
          if (error) {
            finish(new HttpError(502, "SSH 未能启动指定命令"));
            return;
          }
          channel = stream;
          if (done) {
            stream.close();
            return;
          }
          const collect = (chunk: Buffer, isError = false) => {
            try {
              if (signal.aborted) {
                finish();
                return;
              }
              actor.guard();
              this.revalidate({
                sessionId: actor.sessionId,
                resourceId: plan.resource.id,
                configurationRevision: plan.revision,
                resourceRevision: plan.resourceRevision,
                readOnly: plan.readOnly,
              } as CommandRecord);
              if (stdout.length + stderr.length + chunk.length > outputLimit)
                throw new HttpError(413, "SSH 命令输出超过预算");
              if (isError) stderr = Buffer.concat([stderr, chunk]);
              else stdout = Buffer.concat([stdout, chunk]);
              void options.onEvent?.({
                type: "progress",
                elapsedMs: Date.now() - +startedAt,
                stdoutBytes: stdout.length,
                stderrBytes: stderr.length,
                stdoutTail: this.scrub(stdout.toString("utf8")).slice(-2048),
                stderrTail: this.scrub(stderr.toString("utf8")).slice(-2048),
                timestamp: new Date(),
              });
            } catch (error) {
              finish(error);
            }
          };
          stream.on("data", (chunk: Buffer) => collect(chunk));
          stream.stderr.on("data", (chunk: Buffer) => collect(chunk, true));
          stream.on("exit", (code: number) => (exitCode = code));
          stream.once("close", () => finish());
          stream.once("error", () =>
            finish(new HttpError(502, "SSH 命令通道中断，结果需要核实")),
          );
        });
        connection.once("close", () =>
          finish(
            exitCode === undefined
              ? new HttpError(502, "SSH 在取得退出状态前断开")
              : undefined,
          ),
        );
      });
    } finally {
      connection.end();
    }
  }
  async close() {
    await Promise.all(
      [...this.lives.values()].map(async (live) => {
        live.controller.abort();
        await live.cancel?.();
        await live.promise;
      }),
    );
  }
}
