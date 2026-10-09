import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { readFile, chmod } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { ConfigSchema, type Config, type Provider } from "../domain/config.js";
import type {
  Session,
  TaskContract,
  Resource,
  Service,
  SpecialistRun,
  Activity,
  TaskStep,
  Evidence,
  Observation,
  ToolResult,
  Action,
  ExecutionSession,
} from "../domain/entities.js";
import { toolResult } from "../domain/entities.js";
import type { ExecutionAdapterPort, ModelPort } from "../domain/ports.js";
import { requireCondition, LakeError } from "../domain/errors.js";
import { changeCommands } from "../domain/events.js";
import { publicProjection } from "../domain/schemas.js";
import { runtimeReadiness } from "../adapters/readiness.js";
import { resolveWorkspaces } from "./workspaces.js";
import { hostStatus } from "../adapters/host-status.js";
import { generalProfile } from "../specialists/profile.js";
import { wireName } from "../agent/tool-catalog.js";
import { InvocationSchema } from "../domain/invocation.js";
import { prepareHome } from "./home.js";
import { acquireDaemonLock } from "./daemon-lock.js";
import { SqliteStore } from "../storage/store.js";
import { Redactor, StreamingRedactor } from "../storage/redaction.js";
import { CredentialStore } from "../storage/credentials.js";
import { ArtifactStore } from "../storage/artifacts.js";
import { CheckpointStore } from "../storage/checkpoints.js";
import { EventStore, eventCommand } from "../storage/events.js";
import { SkillRegistry } from "../skills/registry.js";
import { SkillLoader } from "../skills/loader.js";
import { readSkillCatalog } from "../adapters/skill-source.js";
import { PowerRegistry } from "../operations/power-registry.js";
import { GrantService } from "../operations/grants.js";
import { ApprovalService } from "../operations/approvals.js";
import { OperationGateway } from "../operations/gateway.js";
import { resolveTargets } from "../operations/scope.js";
import { powerSchemas } from "../operations/power-manifest.js";
import { ResourceLockService } from "../runner/resource-locks.js";
import { ActionRunner } from "../runner/action-runner.js";
import { Reconciler } from "../runner/reconciler.js";
import { RecoveryService } from "../runner/recovery.js";
import { replaceConfigAndVerify } from "../runner/config-change.js";
import { WorkspaceAdapter, sha256 } from "../adapters/workspace.js";
import { ContainerSandbox } from "../adapters/sandbox.js";
import { SshAdapter } from "../adapters/ssh.js";
import { KubeAdapter } from "../adapters/kubernetes.js";
import { PostgresAdapter } from "../adapters/postgres.js";
import { HttpProbeAdapter } from "../adapters/http-probe.js";
import { ChatModelAdapter } from "../adapters/model/chat-completions.js";
import { BudgetService, initialBudget } from "../agent/budget.js";
import { ModelLimiter } from "../agent/model-limiter.js";
import { AgentRuntime } from "../agent/runtime.js";
import { ToolCatalog } from "../agent/tool-catalog.js";
import { ToolExecutor } from "../agent/tool-executor.js";
import type { ToolContext } from "../agent/tool-catalog.js";
import { SpecialistService } from "../specialists/service.js";
import { SpecialistScheduler } from "../specialists/scheduler.js";
import { SpecialistStateService } from "../specialists/state.js";
import { TaskProgressService, stableId } from "../specialists/task-progress.js";
import { InboxService } from "../specialists/inbox.js";
import { ExecutionSessionService } from "../sessions/execution-session.js";
import { InputControl } from "../sessions/input-control.js";
import { TerminalOutput } from "../sessions/terminal-output.js";
import { HandoffService } from "../sessions/handoff.js";
import { Verifier } from "../verification/verifier.js";
import { DeliveryGate } from "../verification/delivery-gate.js";
import { EvidencePolicy } from "../verification/evidence-policy.js";
import { DataService } from "./data-service.js";
import { importResources, importServices } from "./imports.js";
import { recordObservation, updateHypothesis } from "./investigation.js";
import { buildEvidenceReport } from "./report.js";
const builtin = new URL("../../builtin/", import.meta.url);
const creation = z
  .object({
    lakeId: z.uuid(),
    environmentId: z.uuid(),
    objective: z.string().min(1).max(65536),
    resourceIds: z.array(z.uuid()).min(1),
    providerId: z.string().optional(),
    invocation: InvocationSchema.optional(),
    parentSessionId: z.uuid().optional(),
    intent: z.enum(["diagnose", "recover", "change"]).default("diagnose"),
    constraints: z.array(z.string()).default([]),
    acceptanceCriteria: z
      .array(
        z.object({
          id: z.string(),
          label: z.string(),
          type: z.enum(["observation", "http_health", "manual"]),
          required: z.boolean(),
          resourceId: z.uuid().optional(),
        }),
      )
      .optional(),
  })
  .strict();
export class LakeApplication {
  readonly events: EventStore;
  readonly credentials: CredentialStore;
  readonly artifacts: ArtifactStore;
  readonly checkpoints: CheckpointStore;
  readonly data: DataService;
  readonly budget: BudgetService;
  readonly skills = new SkillRegistry();
  readonly powers = new PowerRegistry();
  readonly catalog = new ToolCatalog();
  readonly grants: GrantService;
  readonly approvals: ApprovalService;
  readonly locks: ResourceLockService;
  readonly sessions: ExecutionSessionService;
  readonly inputs: InputControl;
  readonly output: TerminalOutput;
  readonly specialists: SpecialistService;
  readonly scheduler: SpecialistScheduler;
  readonly state: SpecialistStateService;
  readonly progress: TaskProgressService;
  readonly gate: DeliveryGate;
  readonly verifier: Verifier;
  readonly runner: ActionRunner;
  readonly gateway: OperationGateway;
  readonly reconciler: Reconciler;
  readonly handoff: HandoffService;
  private readonly http = new HttpProbeAdapter();
  private readonly ssh: SshAdapter;
  private readonly workspace: WorkspaceAdapter;
  private readonly kube: KubeAdapter;
  private readonly postgres: PostgresAdapter;
  private readonly sandbox: ContainerSandbox;
  private readonly limiter: ModelLimiter;
  private readonly roots = new Map<string, Promise<void>>();
  private readonly runtimes = new Map<string, AgentRuntime>();
  private readonly wakeHashes = new Map<string, string>();
  private readonly ptys = new Map<
    string,
    {
      write(text: string): void;
      close(): void;
    }
  >();
  private readonly inbox: InboxService;
  private readonly executor: ToolExecutor;
  private stopped = false;
  private timer: NodeJS.Timeout | undefined;
  constructor(
    readonly store: SqliteStore,
    readonly config: Config,
    readonly paths: {
      home: string;
      agent: string;
      database: string;
    },
    private readonly lock: {
      release(): Promise<void>;
    },
    readonly redactor: Redactor,
    private readonly modelFactory?: (provider: Provider) => ModelPort,
    fault?: (point: string, action: Action) => Promise<void>,
  ) {
    this.events = new EventStore(store);
    this.credentials = new CredentialStore(
      join(paths.home, "secrets"),
      redactor,
    );
    this.artifacts = new ArtifactStore(
      join(paths.agent, "artifacts"),
      store,
      redactor,
      config.limits.maxArtifactBytes,
    );
    this.checkpoints = new CheckpointStore(store, this.artifacts);
    this.data = new DataService(store);
    this.budget = new BudgetService(store, config.providers);
    this.grants = new GrantService(store);
    this.approvals = new ApprovalService(store);
    this.locks = new ResourceLockService(
      store,
      config.limits.maxParallelReadsPerResource,
    );
    this.limiter = new ModelLimiter(config.limits.maxActiveModelRequests);
    this.ssh = new SshAdapter(this.credentials, this.artifacts);
    this.sandbox = new ContainerSandbox(join(paths.home, "secrets"));
    this.workspace = new WorkspaceAdapter(
      this.artifacts,
      join(paths.home, "secrets"),
    );
    this.kube = new KubeAdapter(this.credentials);
    this.postgres = new PostgresAdapter(this.credentials);
    this.sessions = new ExecutionSessionService(store, async (r) => {
      if (r.kind === "ssh") await this.ssh.connect(r);
    });
    this.inputs = new InputControl(store, config.limits.terminalInputLeaseMs);
    this.output = new TerminalOutput(
      store,
      (text) => redactor.text(text),
      () => new StreamingRedactor(redactor),
    );
    this.gate = new DeliveryGate(store);
    this.inbox = new InboxService(store);
    this.state = new SpecialistStateService(store);
    this.progress = new TaskProgressService(store, async (step, ids) => {
      const facts = [
        ...(await store.list<Evidence>("evidence")),
        ...(await store.list<Observation>("observations")),
      ];
      return (
        ids.length > 0 &&
        ids.every((id) =>
          facts.some(
            (e) =>
              e.id === id &&
              e.taskId === step.taskId &&
              new EvidencePolicy().isFresh(e) &&
              (!("result" in e) || e.result === true),
          ),
        )
      );
    });
    this.specialists = new SpecialistService(
      store,
      this.skills,
      config.profiles as SpecialistRun["profile"][],
      config.limits.specialistMaxModelCalls,
    );
    this.scheduler = new SpecialistScheduler(
      store,
      (run, signal) => this.runSpecialist(run, signal),
      config.limits.maxActiveSpecialists,
    );
    this.verifier = new Verifier(
      store,
      (r, s) =>
        this.http.healthWindow(r, s.health, new AbortController().signal),
      (a, r) => this.postcondition(a, r),
    );
    const adapter: ExecutionAdapterPort = {
      execute: (capability, resource, parameters, signal) =>
        this.executePower(capability, resource, parameters, signal),
    };
    this.runner = new ActionRunner(
      store,
      adapter,
      this.verifier,
      (result) => redactor.value(result) as ToolResult,
      (id, text, a) => this.output.appendOutput(id, text, a),
      "local-user",
      fault,
      {
        readTimeoutMs: config.limits.readToolTimeoutMs,
        changeTimeoutMs: config.limits.changeToolTimeoutMs,
        maxReadRetries: config.limits.maxReadRetries,
      },
      async (action, stage) => {
        if (action.actor === action.sessionId) return;
        const run = await store.get<SpecialistRun>(
          "specialist_runs",
          action.actor,
        );
        if (!run) return;
        if (
          stage !== "idle" &&
          (action.effect === "change" || action.capability.includes("health"))
        )
          await this.state.setPhase(
            action.actor,
            stage === "execution" && action.effect === "change"
              ? "remediating"
              : "verifying",
          );
        const activity: Activity =
          stage === "idle"
            ? "idle"
            : stage === "verification"
              ? (action.effect === "change" &&
                  action.capability.startsWith("ssh.")) ||
                action.capability.includes("health")
                ? "verifying_health"
                : "querying_resource"
              : /replace_config|apply_patch/.test(action.capability)
                ? "editing_config"
                : action.effect === "change"
                  ? "executing_command"
                  : /log/.test(action.capability)
                    ? "reading_logs"
                    : action.capability.includes("health")
                      ? "verifying_health"
                      : "querying_resource";
        const current =
          stage === "idle"
            ? await store.get<Action>("actions", action.id)
            : action;
        await this.state.changeActivity(
          action.actor,
          activity,
          current?.status === "unknown"
            ? "unknown_effect"
            : run.state.status === "waiting"
              ? "waiting_dependency"
              : undefined,
          {
            actionId: action.id,
            ...(action.terminalSessionId
              ? { terminalSessionId: action.terminalSessionId }
              : {}),
          },
        );
      },
    );
    this.gateway = new OperationGateway(
      store,
      this.powers,
      this.grants,
      this.approvals,
      this.locks,
      (id, signal) => this.runner.run(id, signal),
      config.limits.maxMutatingActionsPerTask,
      "local-user",
      config.limits.terminalInputLeaseMs,
    );
    this.reconciler = new Reconciler(
      store,
      (a, r) => this.inspect(a, r),
      this.verifier,
    );
    this.handoff = new HandoffService(
      store,
      this.grants,
      this.locks,
      async (id) => {
        this.ptys.get(id)?.close();
        this.ptys.delete(id);
        await this.output.finishStream(id);
      },
      config.limits.humanLeaseMs,
    );
    this.executor = new ToolExecutor(
      this.catalog,
      store,
      async (result, context) => {
        const safe = this.redactor.value(result) as ToolResult;
        const serialized = JSON.stringify(safe.data);
        if (
          Buffer.byteLength(serialized) <= this.config.limits.maxInlineToolBytes
        )
          return safe;
        const artifactId = await this.artifacts.put(
          serialized,
          context.sessionId,
        );
        return {
          ...safe,
          data: {
            excerpt: Buffer.from(serialized)
              .subarray(0, this.config.limits.maxInlineToolBytes / 2)
              .toString(),
            artifactId,
          },
          artifactRefs: [...safe.artifactRefs, artifactId],
          truncated: true,
        };
      },
    );
  }
  async start(background = true): Promise<void> {
    await this.artifacts.cleanUnreferenced();
    for (const f of await readSkillCatalog(
      new URL("skills/", builtin).pathname,
    ))
      this.skills.register(f.text, f.source, true);
    for (const root of this.config.trustedSkillRoots)
      for (const f of await readSkillCatalog(root))
        this.skills.register(f.text, f.source, false);
    for (const id of ["local-files", "ssh", "k8s", "postgres", "http-health"])
      this.powers.register(
        JSON.parse(
          await readFile(new URL(`powers/${id}.json`, builtin), "utf8"),
        ),
      );
    this.registerTools();
    await new RecoveryService(
      this.store,
      (id) => this.reconciler.reconcile(id),
      async (id, sessionId) => {
        const s = await this.store.get<Session>("sessions", sessionId);
        await this.budget.settle(id, null, s?.providerId ?? "unknown-provider");
      },
    ).recover();
    if (background)
      this.timer = setInterval(() => {
        void this.tick().catch(() => {});
      }, 100);
  }
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.scheduler.stop();
    for (const runtime of this.runtimes.values()) runtime.interrupt();
    this.runner.stop();
    for (const pty of this.ptys.values()) pty.close();
    await Promise.allSettled([...this.roots.values()]);
    await this.scheduler.drain();
    await this.runner.drain();
    await this.ssh.close();
    await this.store.close();
    await this.lock.release();
  }
  private async tick(): Promise<void> {
    if (this.stopped) return;
    await this.handoff.expireLeases();
    await this.finalizeCancelled();
    await this.scheduler.schedule();
    await this.runner.tick();
    const actions = await this.store.list<Action>("actions");
    for (const r of await this.store.list<SpecialistRun>("specialist_runs"))
      if (
        r.state.status === "waiting" &&
        [
          "approval_required",
          "waiting_input_control",
          "waiting_dependency",
          "approval_or_dependency",
        ].includes(r.state.waitingReason ?? "") &&
        !r.cancelRequestedAt
      ) {
        const owned = actions.filter((a) => a.actor === r.id);
        if (
          owned.some((a) =>
            [
              "waiting_approval",
              "unknown",
              "queued",
              "dispatched",
              "verifying",
            ].includes(a.status),
          )
        )
          continue;
        let queued = false;
        for (const a of owned.filter((a) => a.status === "authorized")) {
          try {
            queued = (await this.gateway.dispatch(a.id)) || queued;
          } catch {}
        }
        if (
          !queued &&
          owned.length &&
          owned.every((a) =>
            ["succeeded", "failed", "blocked", "cancelled"].includes(a.status),
          )
        )
          await this.specialists.resume(r.id);
      }
    for (const t of await this.store.list<TaskContract>("tasks"))
      if (
        t.status === "waiting" &&
        [
          "waiting_dependency",
          "approval_required",
          "waiting_input_control",
          "approval_or_dependency",
        ].includes(String(t.waitingReason))
      ) {
        const runs = (
          await this.store.list<SpecialistRun>("specialist_runs")
        ).filter((r) => r.taskId === t.id);
        const hash = JSON.stringify(runs.map((r) => [r.id, r.state.status]));
        if (this.wakeHashes.get(t.id) !== hash) {
          this.wakeHashes.set(t.id, hash);
          if (
            runs.some((r) =>
              ["succeeded", "failed", "cancelled"].includes(r.state.status),
            )
          )
            this.startRoot(t.sessionId);
        }
      }
  }
  async cancelSpecialist(id: string): Promise<void> {
    await this.specialists.cancel(id);
    this.scheduler.cancel(id);
    for (const action of await this.store.list<Action>("actions"))
      if (action.actor === id) await this.runner.cancel(action.id);
    await this.finalizeCancelled();
  }
  private async finalizeCancelled(): Promise<void> {
    const unsettled = (a: Action) =>
      ["queued", "dispatched", "observed", "verifying", "unknown"].includes(
        a.status,
      );
    const actions = await this.store.list<Action>("actions");
    for (const run of await this.store.list<SpecialistRun>("specialist_runs")) {
      if (
        !run.cancelRequestedAt ||
        actions.some((a) => a.actor === run.id && unsettled(a))
      )
        continue;
      const parent = await this.store.get<TaskContract>("tasks", run.taskId);
      const commands = [];
      if (run.state.status !== "cancelled")
        commands.push(
          ...changeCommands(
            "specialist_runs",
            {
              ...run,
              revision: run.revision + 1,
              state: {
                ...run.state,
                status: "cancelled",
                activity: "idle",
                revision: run.state.revision + 1,
              },
            },
            "specialist.finished",
            "system",
            new Date().toISOString(),
          ),
        );
      for (const step of await this.store.list<TaskStep>("task_steps"))
        if (
          step.assignee === run.id &&
          !["succeeded", "failed", "cancelled"].includes(step.status)
        ) {
          if (parent?.cancelRequestedAt)
            commands.push(
              ...changeCommands(
                "task_steps",
                { ...step, revision: step.revision + 1, status: "cancelled" },
                "step.updated",
                "system",
                new Date().toISOString(),
              ),
            );
          else {
            const blocked = {
              ...step,
              revision: step.revision + 1,
              status: "blocked" as const,
            };
            commands.push(
              ...changeCommands(
                "task_steps",
                blocked,
                "step.updated",
                "system",
                new Date().toISOString(),
              ),
            );
            const released = {
              ...blocked,
              revision: blocked.revision + 1,
              status: "pending" as const,
            };
            delete released.assignee;
            commands.push(
              ...changeCommands(
                "task_steps",
                released,
                "step.updated",
                "system",
                new Date().toISOString(),
              ),
            );
          }
        }
      if (commands.length) await this.store.transact(commands);
    }
    for (const task of await this.store.list<TaskContract>("tasks"))
      if (
        task.cancelRequestedAt &&
        ["waiting", "cancelled"].includes(task.status) &&
        !actions.some((a) => a.taskId === task.id && unsettled(a))
      ) {
        const commands = [];
        for (const step of await this.store.list<TaskStep>("task_steps"))
          if (
            step.taskId === task.id &&
            !["succeeded", "failed", "cancelled"].includes(step.status)
          )
            commands.push(
              ...changeCommands(
                "task_steps",
                { ...step, revision: step.revision + 1, status: "cancelled" },
                "step.updated",
                "system",
                new Date().toISOString(),
              ),
            );
        if (commands.length) await this.store.transact(commands);
        if (task.status !== "cancelled")
          await this.setTask(task, { status: "cancelled" });
      }
  }
  async diagnostics(): Promise<unknown> {
    return runtimeReadiness();
  }
  async importResources(input: unknown): Promise<void> {
    await importResources(this.store, input);
  }
  async importServices(input: unknown): Promise<void> {
    await importServices(this.store, input);
  }
  async createSession(
    input: unknown,
    id: string = randomUUID(),
  ): Promise<Session> {
    const existing = await this.store.get<Session>("sessions", id);
    if (existing) return existing;
    const p = creation.parse(input);
    const environment = await this.store.get<any>(
      "environments",
      p.environmentId,
    );
    requireCondition(environment?.lakeId === p.lakeId, "scope_denied");
    for (const resourceId of p.resourceIds) {
      const r = await this.store.get<Resource>("resources", resourceId);
      requireCondition(
        r?.lakeId === p.lakeId && r.environmentId === p.environmentId,
        "scope_denied",
      );
    }
    const providerId = p.providerId ?? this.config.defaultProvider;
    this.provider(providerId);
    const deadline = new Date(
        Date.now() + this.config.limits.sessionWallTimeMs,
      ).toISOString(),
      taskId = stableId("task:" + id);
    const session: Session = {
      id,
      revision: 1,
      lakeId: p.lakeId,
      environmentId: p.environmentId,
      status: "active",
      rootTaskId: taskId,
      createdAt: new Date().toISOString(),
      ...(p.parentSessionId ? { parentSessionId: p.parentSessionId } : {}),
      providerId,
      eventCursor: "0",
      ...(p.invocation ? { invocation: p.invocation } : {}),
      budget: initialBudget(
        p.invocation?.maxCalls ?? this.config.limits.sessionMaxModelCalls,
        p.invocation?.maxTokens ?? this.config.limits.sessionMaxEstimatedTokens,
        deadline,
      ),
    };
    const healthResources =
      p.intent === "diagnose"
        ? []
        : (await this.store.list<Service>("services"))
            .filter(
              (s) =>
                s.lakeId === p.lakeId &&
                s.environmentId === p.environmentId &&
                s.health &&
                s.resourceBindings.every((b) =>
                  p.resourceIds.includes(b.resourceId),
                ),
            )
            .flatMap((s) =>
              s.resourceBindings
                .filter((b) => s.health && p.resourceIds.includes(b.resourceId))
                .map((b) => b.resourceId),
            );
    const boundHealth = (await this.store.list<Resource>("resources")).filter(
      (r) => healthResources.includes(r.id) && r.kind === "http",
    );
    requireCondition(
      p.intent === "diagnose" ||
        p.acceptanceCriteria?.some(
          (c) => c.required && c.type === "http_health",
        ) ||
        boundHealth.length > 0,
      "precondition_failed",
      "Import a service health profile and select its resources for recovery or change",
    );
    const criteria =
      p.acceptanceCriteria ??
      (p.intent === "diagnose"
        ? [
            {
              id: "sourced-findings",
              label: "有来源的诊断发现",
              type: "observation" as const,
              required: true,
            },
          ]
        : boundHealth.map((r) => ({
            id: "business-health:" + r.id,
            label: "业务健康：" + r.name,
            type: "http_health" as const,
            required: true,
            resourceId: r.id,
          })));
    requireCondition(
      criteria.every(
        (c) => !c.resourceId || p.resourceIds.includes(c.resourceId),
      ),
      "scope_denied",
    );
    const task: TaskContract = {
      id: taskId,
      revision: 1,
      sessionId: id,
      objective: p.objective,
      intent: p.intent,
      scope: p.resourceIds,
      constraints: p.constraints,
      acceptanceCriteria: JSON.parse(JSON.stringify(criteria)),
      deadline,
      status: "active",
      contractRevision: 1,
    };
    await this.store.transact([
      ...changeCommands(
        "sessions",
        session,
        "session.created",
        "local-user",
        new Date().toISOString(),
      ),
      ...changeCommands(
        "tasks",
        task,
        "task.created",
        "local-user",
        new Date().toISOString(),
      ),
    ]);
    return session;
  }
  async inspectLocalStatus(cwd: string, id: string): Promise<unknown> {
    const started = performance.now(),
      scope = await resolveWorkspaces(this, [cwd], "read-only");
    const session = await this.createSession(
      {
        lakeId: scope.lakeId,
        environmentId: scope.environmentId,
        resourceIds: scope.resourceIds,
        objective: "查看本机系统状态",
        invocation: {
          cwd: scope.roots[0],
          workspaceRoots: scope.roots,
          sandboxMode: "read-only",
        },
      },
      id,
    );
    try {
      const result = await this.gateway.execute(
        {
          sessionId: session.id,
          taskId: session.rootTaskId,
          actor: session.id,
          capability: "local-files.system.status",
          resourceId: scope.resourceIds[0],
          parameters: {},
          callKey: "local-status",
        },
        new AbortController().signal,
      );
      requireCondition(
        result.status === "ok",
        "precondition_failed",
        "Local inspection failed",
      );
      const delivery = await this.gate.evaluate(session.rootTaskId);
      requireCondition(delivery.status === "verified", "precondition_failed");
      const reportArtifactId = await this.artifacts.put(
          JSON.stringify(
            await buildEvidenceReport(this.store, session.rootTaskId, delivery),
          ),
          session.id,
        ),
        task = await this.store.get<TaskContract>("tasks", session.rootTaskId);
      requireCondition(task, "not_found");
      await this.setTask(task, { status: "succeeded", reportArtifactId });
      return this.redactor.value({
        sessionId: session.id,
        taskId: session.rootTaskId,
        reportArtifactId,
        durationMs: Math.round(performance.now() - started),
        modelCalls: 0,
        status: (
          result.data as { execution: Awaited<ReturnType<typeof hostStatus>> }
        ).execution,
      });
    } catch (error) {
      const task = await this.store.get<TaskContract>(
        "tasks",
        session.rootTaskId,
      );
      if (task) await this.setTask(task, { status: "failed" });
      throw error;
    }
  }
  provider(id: string): Provider {
    const p = this.config.providers.find((p) => p.id === id);
    requireCondition(p, "not_found", "Configured provider is missing");
    return p;
  }
  private model(provider: Provider): ModelPort {
    const raw =
        this.modelFactory?.(provider) ??
        new ChatModelAdapter(
          provider,
          this.credentials,
          this.config.limits.modelRequestTimeoutMs,
        ),
      redactor = this.redactor;
    return this.limiter.wrap({
      async *stream(request) {
        const stream = new StreamingRedactor(redactor);
        for await (const event of raw.stream(request)) {
          if (event.type === "text") {
            const text = stream.push(event.text);
            if (text) yield { type: "text" as const, text };
          } else {
            const tail = stream.flush();
            if (tail) yield { type: "text" as const, text: tail };
            yield {
              ...event,
              message: redactor.value(event.message) as typeof event.message,
            };
          }
        }
      },
    });
  }
  startRoot(sessionId: string): void {
    if (this.stopped || this.roots.has(sessionId)) return;
    let yielded = false;
    const promise = this.runRoot(sessionId)
      .then((value) => {
        yielded = value;
      })
      .finally(async () => {
        let wake = false;
        try {
          // A message can arrive after the runtime's final inbox check while this
          // root is still registered. Restart only for durable, unconsumed input.
          if (
            this.stopped ||
            !yielded ||
            !(await this.inbox.pending(sessionId)).length
          )
            return;
          const session = await this.store.get<Session>("sessions", sessionId);
          const task = session
            ? await this.store.get<TaskContract>("tasks", session.rootTaskId)
            : undefined;
          if (
            !task ||
            task.cancelRequestedAt ||
            !["active", "waiting"].includes(task.status)
          )
            return;
          await this.setTask(task, { status: "active" });
          wake = true;
        } finally {
          // Keep the root registered until finalization ends so shutdown waits
          // for these storage reads before closing the database.
          this.roots.delete(sessionId);
          if (wake && !this.stopped) this.startRoot(sessionId);
        }
      });
    this.roots.set(sessionId, promise);
    void promise.catch(() => {});
  }
  private async runRoot(sessionId: string): Promise<boolean> {
    const session = await this.store.get<Session>("sessions", sessionId);
    requireCondition(session, "not_found");
    const task = await this.store.get<TaskContract>(
      "tasks",
      session.rootTaskId,
    );
    requireCondition(task, "not_found");
    if (["succeeded", "qualified", "failed", "cancelled"].includes(task.status))
      return false;
    try {
      const runtime = await this.makeRuntime(sessionId, task.id, sessionId);
      this.runtimes.set(sessionId, runtime);
      const result = await runtime.run();
      const latest = await this.store.get<TaskContract>("tasks", task.id);
      if (
        latest &&
        !["succeeded", "qualified", "failed", "cancelled"].includes(
          latest.status,
        )
      )
        await this.setTask(latest, {
          status: "waiting",
          waitingReason: (result.data as any)?.reason ?? "waiting_dependency",
        });
      return true;
    } catch (error) {
      const latest = await this.store.get<TaskContract>("tasks", task.id);
      if (
        latest &&
        !["succeeded", "qualified", "failed", "cancelled"].includes(
          latest.status,
        )
      ) {
        const waiting =
          error instanceof LakeError &&
          [
            "budget_exhausted",
            "context_exhausted",
            "model_protocol_error",
            "timeout",
            "capability_unavailable",
            "prerequisite_missing",
            "not_found",
            "no_progress",
            "cancelled",
          ].includes(error.code);
        await this.setTask(latest, {
          status: waiting ? "waiting" : "failed",
          waitingReason:
            error instanceof LakeError ? error.code : "model_protocol_error",
        });
      }
      return false;
    } finally {
      this.runtimes.delete(sessionId);
    }
  }
  private async setTask(
    task: TaskContract,
    patch: Record<string, unknown>,
  ): Promise<void> {
    for (let attempt = 0; attempt < 10; attempt++) {
      const current = await this.store.get<TaskContract>("tasks", task.id);
      requireCondition(current, "not_found");
      // Late model completion must not reopen an already finished or cancelled task.
      if (
        ["succeeded", "qualified", "failed", "cancelled"].includes(
          current.status,
        ) &&
        patch.status !== current.status
      )
        return;
      if (["succeeded", "qualified"].includes(String(patch.status))) {
        const delivery = await this.gate.evaluate(current.id);
        requireCondition(
          delivery.status ===
            (patch.status === "succeeded" ? "verified" : "qualified"),
          "precondition_failed",
          "Delivery changed while work was running",
        );
      }
      const value = { ...current, ...patch, revision: current.revision + 1 };
      if (value.status !== "waiting") delete value.waitingReason;
      const s = await this.store.get<Session>("sessions", current.sessionId);
      requireCondition(s, "not_found");
      const commands = changeCommands(
        "tasks",
        value,
        "task.updated",
        "system",
        new Date().toISOString(),
      );
      if (s.rootTaskId === task.id)
        commands.push(
          ...changeCommands(
            "sessions",
            { ...s, revision: s.revision + 1, status: value.status },
            "session.context_changed",
            "system",
            new Date().toISOString(),
          ),
        );
      try {
        await this.store.transact(commands);
        return;
      } catch (error) {
        if (!(error instanceof LakeError && error.code === "conflict"))
          throw error;
      }
    }
    throw new LakeError("conflict");
  }
  private async runSpecialist(
    run: SpecialistRun,
    signal: AbortSignal,
  ): Promise<void> {
    let runtime: AgentRuntime | undefined;
    const abort = () => runtime?.interrupt();
    signal.addEventListener("abort", abort, { once: true });
    try {
      const resources = await Promise.all(
        run.workOrder.resourceIds.map((id) =>
          this.store.get<Resource>("resources", id),
        ),
      );
      for (const manifest of this.powers.project())
        if (
          resources.some(
            (r) => r && manifest.requiredResourceKinds.includes(r.kind),
          )
        )
          await this.powers.enable(this.store, run.id, manifest.id);
      for (const id of run.profile.defaultPowers)
        await this.powers.enable(this.store, run.id, id);
      runtime = await this.makeRuntime(run.sessionId, run.taskId, run.id);
      this.runtimes.set(run.id, runtime);
      if (signal.aborted) runtime.interrupt();
      const result = await runtime.run();
      const current = await this.store.get<SpecialistRun>(
        "specialist_runs",
        run.id,
      );
      if (
        current &&
        !["succeeded", "failed", "cancelled"].includes(current.state.status)
      )
        await this.store.transact(
          changeCommands(
            "specialist_runs",
            {
              ...current,
              revision: current.revision + 1,
              state: {
                ...current.state,
                status: "waiting",
                activity: "idle",
                waitingReason:
                  (result.data as any)?.reason ?? "waiting_dependency",
                revision: current.state.revision + 1,
              },
            },
            "specialist.state_changed",
            run.id,
            new Date().toISOString(),
          ),
        );
    } catch (error) {
      const current = await this.store.get<SpecialistRun>(
        "specialist_runs",
        run.id,
      );
      if (
        current &&
        !["succeeded", "failed", "cancelled"].includes(current.state.status)
      )
        await this.store.transact(
          changeCommands(
            "specialist_runs",
            {
              ...current,
              revision: current.revision + 1,
              state: {
                ...current.state,
                status:
                  error instanceof LakeError &&
                  [
                    "cancelled",
                    "budget_exhausted",
                    "context_exhausted",
                    "no_progress",
                  ].includes(error.code)
                    ? "waiting"
                    : "failed",
                activity: "idle",
                waitingReason:
                  error instanceof LakeError
                    ? error.code
                    : "model_protocol_error",
                revision: current.state.revision + 1,
              },
            },
            "specialist.finished",
            run.id,
            new Date().toISOString(),
          ),
        );
    } finally {
      signal.removeEventListener("abort", abort);
      this.runtimes.delete(run.id);
    }
  }
  private readonly loaders = new Map<string, SkillLoader>();
  private async makeRuntime(
    sessionId: string,
    taskId: string,
    actor: string,
  ): Promise<AgentRuntime> {
    const session = await this.store.get<Session>("sessions", sessionId);
    requireCondition(session, "not_found");
    const run =
      actor === sessionId
        ? undefined
        : await this.store.get<SpecialistRun>("specialist_runs", actor);
    const profile = run?.profile;
    const provider = this.provider(
      profile?.modelOverride ?? session.providerId,
    );
    const taskScope = await this.store.get<TaskContract>("tasks", taskId);
    const scopeResources = await Promise.all(
      (run?.workOrder.resourceIds ?? taskScope?.scope ?? []).map((id) =>
        this.store.get<Resource>("resources", id),
      ),
    );
    const availablePowers = this.powers
      .project()
      .filter((m) =>
        scopeResources.some(
          (r) => r && m.requiredResourceKinds.includes(r.kind),
        ),
      );
    const selectedProvider = {
      ...provider,
      ...(!profile?.modelOverride && session.invocation?.model
        ? { model: session.invocation.model }
        : {}),
      ...(session.invocation?.reasoningEffort
        ? { reasoningEffort: session.invocation.reasoningEffort }
        : {}),
    };
    const snapshot = run?.workOrder.skillSnapshot ?? this.skills.resolve();
    const loader = new SkillLoader(snapshot);
    this.loaders.set(actor, loader);
    const latest = (await this.store.list<any>("checkpoints"))
      .filter((c) => c.actor === actor && c.sessionId === sessionId)
      .at(-1);
    const restored = latest
      ? ((await this.checkpoints.load(latest.id)) as {
          runtime?: { summary?: string; retained?: number };
          skillDigests?: string[];
        })
      : undefined;
    if (restored?.skillDigests) loader.restore(restored.skillDigests);
    const identity = await readFile(
        new URL(`prompts/${run ? "specialist" : "coordinator"}.md`, builtin),
        "utf8",
      ),
      baseline = await readFile(
        new URL("prompts/sre-base.md", builtin),
        "utf8",
      );
    const runtime = new AgentRuntime(
      this.store,
      this.model(selectedProvider),
      selectedProvider,
      this.catalog,
      this.executor,
      this.budget,
      {
        sessionId,
        taskId,
        actor,
        role: run ? "specialist" : "coordinator",
        powerBindings: run?.powerBindings ?? availablePowers.map((m) => m.id),
      },
      {
        context: async () => {
          const task = await this.store.get<TaskContract>("tasks", taskId);
          requireCondition(task, "not_found");
          const pending = await this.inbox.history(actor);
          const value = {
            identity: identity + "\n" + (profile?.instructions ?? ""),
            baseline,
            objective: run?.workOrder.objective ?? task.objective,
            constraints: task.constraints,
            shared: {
              availablePowers: availablePowers.map((m) => ({
                id: m.id,
                description: m.description,
                resourceKinds: m.requiredResourceKinds,
                tools: m.tools
                  .filter((t) => Boolean(run) || t.effect === "read")
                  .map((t) => ({
                    capability: m.id + "." + t.name,
                    toolName: wireName(m.id + "." + t.name),
                    effect: t.effect,
                    description: t.description,
                  })),
              })),
              specialistProfiles: [generalProfile, ...this.config.profiles].map(
                (p) => ({ id: p.id, name: p.name }),
              ),
              ...((await this.data.agentContext(sessionId)) as Record<
                string,
                unknown
              >),
              ...(run
                ? {
                    workOrder: {
                      workerId: run.id,
                      stepIds: run.workOrder.stepIds,
                      resourceIds: run.workOrder.resourceIds,
                    },
                  }
                : {}),
            },
            inbox: pending.map((m) => m.text),
            skills: snapshot.map(({ body, source, ...s }) => s),
            loadedSkills: loader.bodies(),
          };
          await this.inbox.ack(pending.map((m) => m.id));
          return this.redactor.value(value) as typeof value;
        },
        activity: async (activity) => {
          if (run) await this.state.changeActivity(actor, activity as Activity);
          else {
            const current = await this.store.get<Session>(
              "sessions",
              sessionId,
            );
            if (current)
              await this.store.transact([
                eventCommand("model.activity", current, actor, {
                  activity,
                  model: selectedProvider.model,
                }),
              ]);
          }
        },
        delta: async (text) => {
          const current = await this.store.get<Session>("sessions", sessionId);
          if (current)
            await this.store.transact([
              eventCommand("model.delta", current, actor, {
                text: this.redactor.text(text),
              }),
            ]);
        },
        isFinished: async () =>
          run
            ? ["succeeded", "failed", "cancelled"].includes(
                (await this.store.get<SpecialistRun>("specialist_runs", actor))
                  ?.state.status ?? "",
              )
            : ["succeeded", "qualified", "failed", "cancelled"].includes(
                (await this.store.get<TaskContract>("tasks", taskId))?.status ??
                  "",
              ),
        hasPendingInput: async () =>
          (await this.inbox.pending(actor)).length > 0,
        checkpoint: async (state) => {
          const unsettled = (await this.store.list<Action>("actions")).some(
            (a) =>
              a.actor === actor &&
              ["dispatched", "unknown", "verifying"].includes(a.status),
          );
          if (!unsettled)
            await this.checkpoints.save(sessionId, actor, {
              runtime: state,
              skillDigests: loader.digests(),
            });
        },
        progress: async () => {
          const data = await this.data.snapshot(sessionId);
          return JSON.stringify({
            steps: (data.task_steps as any[]).map((s) => [
              s.id,
              s.status,
              s.assignee,
            ]),
            workers: (data.specialist_runs as any[]).map((r) => [
              r.id,
              r.state.status,
              r.powerBindings,
            ]),
            facts: (data.observations as any[])
              .filter((o) => o.trusted)
              .map((o) => o.id),
            terminals: (data.execution_sessions as any[]).map((t) => [
              t.id,
              t.status,
            ]),
            skills: loader.digests(),
          });
        },
      },
      profile?.maxTurns ?? 100,
      {
        maxEquivalentTools: this.config.limits.maxConsecutiveEquivalentTools,
        maxNoProgressCalls:
          this.config.limits.maxConsecutiveNoProgressModelCalls,
        maxModelRetries: this.config.limits.maxModelRetries,
      },
    );
    if (restored?.runtime) {
      const resumeState: { summary?: string; retained?: number } = {};
      if (typeof restored.runtime.summary === "string")
        resumeState.summary = restored.runtime.summary;
      if (
        typeof restored.runtime.retained === "number" &&
        Number.isSafeInteger(restored.runtime.retained) &&
        restored.runtime.retained >= 0
      )
        resumeState.retained = restored.runtime.retained;
      runtime.restore(resumeState);
    }
    return runtime;
  }
  async configureModel(
    sessionId: string,
    providerId: string,
    model?: string,
    reasoningEffort?: import("../domain/invocation.js").Invocation["reasoningEffort"],
  ): Promise<Session> {
    this.provider(providerId);
    const s = await this.store.get<Session>("sessions", sessionId);
    requireCondition(s, "not_found");
    requireCondition(
      !this.roots.has(sessionId) &&
        !(await this.store.list<SpecialistRun>("specialist_runs")).some(
          (r) =>
            r.sessionId === sessionId &&
            ["running", "queued"].includes(r.state.status),
        ),
      "conflict",
      "Wait for active model calls and specialists before changing model",
    );
    const invocation = InvocationSchema.parse({
      ...(s.invocation ?? {
        sandboxMode: "danger-full-access",
        approvalPolicy: "on-request",
        bypassApprovals: false,
      }),
      ...(model ? { model } : {}),
      ...(reasoningEffort ? { reasoningEffort } : {}),
    });
    if (!model) delete invocation.model;
    const next = { ...s, revision: s.revision + 1, providerId, invocation };
    await this.store.transact(
      changeCommands(
        "sessions",
        next,
        "session.context_changed",
        "local-user",
        new Date().toISOString(),
      ),
    );
    this.runtimes.delete(sessionId);
    return next;
  }
  async userMessage(
    sessionId: string,
    text: string,
    expectedRevision: number,
    messageId: string,
    specialistId?: string,
  ): Promise<void> {
    const s = await this.store.get<Session>("sessions", sessionId);
    requireCondition(s, "not_found");
    const task = await this.store.get<TaskContract>("tasks", s.rootTaskId);
    requireCondition(task?.revision === expectedRevision, "conflict");
    const old = await this.store.get("session_messages", messageId);
    if (old) return;
    requireCondition(
      !["succeeded", "failed", "cancelled", "qualified"].includes(task.status),
      "conflict",
      "Create a new task for follow-up work",
    );
    const value = {
      id: messageId,
      revision: 1,
      sessionId,
      text: this.redactor.text(text),
      actor: "local-user",
      createdAt: new Date().toISOString(),
    };
    await this.store.transact([
      ...changeCommands(
        "session_messages",
        value,
        "session.user_input",
        "local-user",
        new Date().toISOString(),
      ),
      ...changeCommands(
        "tasks",
        {
          ...task,
          revision: task.revision + 1,
          status: "active",
          contractRevision: Number(task.contractRevision ?? 1) + 1,
          constraints: [
            ...task.constraints,
            "Latest user instruction: " + this.redactor.text(text),
          ],
        },
        "task.updated",
        "local-user",
        new Date().toISOString(),
      ),
    ]);
    await this.inbox.deliver(
      sessionId,
      specialistId ?? sessionId,
      value.text,
      stableId("message:" + messageId + ":" + (specialistId ?? sessionId)),
    );
    for (const run of await this.store.list<SpecialistRun>("specialist_runs"))
      if (
        run.sessionId === sessionId &&
        !["succeeded", "failed", "cancelled"].includes(run.state.status)
      )
        await this.inbox.deliver(
          sessionId,
          run.id,
          value.text,
          stableId("message:" + messageId + ":" + run.id),
        );
    this.startRoot(sessionId);
  }
  async cancelTask(id: string): Promise<void> {
    const t = await this.store.get<TaskContract>("tasks", id);
    requireCondition(t, "not_found");
    if (["succeeded", "qualified", "failed", "cancelled"].includes(t.status))
      return;
    await this.setTask(t, {
      cancelRequestedAt: new Date().toISOString(),
      status: "waiting",
      waitingReason: "cancelled",
    });
    this.runtimes.get(t.sessionId)?.interrupt();
    for (const r of await this.store.list<SpecialistRun>("specialist_runs"))
      if (r.taskId === id) {
        await this.specialists.cancel(r.id);
        this.scheduler.cancel(r.id);
      }
    for (const a of await this.store.list<Action>("actions"))
      if (a.taskId === id) await this.runner.cancel(a.id);
    const unsettled = (await this.store.list<Action>("actions")).some(
      (a) =>
        a.taskId === id &&
        ["unknown", "dispatched", "verifying"].includes(a.status),
    );
    if (!unsettled) await this.setTask(t, { status: "cancelled" });
  }
  async approve(actionId: string, digest: string): Promise<void> {
    await this.approvals.approve(actionId, digest, "local-user");
    const a = await this.gateway.authorize(actionId);
    if (a.status === "authorized") await this.gateway.dispatch(actionId);
  }
  async resumeSession(id: string): Promise<void> {
    for (const t of await this.store.list<ExecutionSession>(
      "execution_sessions",
    ))
      if (
        t.sessionId === id &&
        t.status === "disconnected" &&
        t.mode === "managed" &&
        !t.paused
      ) {
        const r = await this.store.get<Resource>("resources", t.resourceId);
        if (r) {
          await this.grants.resolve(r, "read", "local-user");
          await this.sessions.open(id, r, t.powerId, t.id);
        }
      }
    const s = await this.store.get<Session>("sessions", id);
    requireCondition(s, "not_found");
    for (const r of await this.store.list<SpecialistRun>("specialist_runs"))
      if (
        r.sessionId === id &&
        ["waiting", "interrupted"].includes(r.state.status) &&
        !r.cancelRequestedAt
      )
        await this.specialists.resume(r.id);
    const task = await this.store.get<TaskContract>("tasks", s.rootTaskId);
    requireCondition(
      task &&
        !task.cancelRequestedAt &&
        ["active", "waiting"].includes(task.status),
      "conflict",
    );
    await this.setTask(task, { status: "active" });
    this.startRoot(id);
  }
  async requestControl(id: string): Promise<number> {
    await this.handoff.requestHandoff(id, "local-user");
    const epoch = await this.handoff.grantHandoff(id, "local-user");
    const t = await this.store.get<ExecutionSession>("execution_sessions", id),
      r = t
        ? await this.store.get<Resource>("resources", t.resourceId)
        : undefined;
    requireCondition(r, "not_found");
    const decoder = new StringDecoder("utf8");
    const pty = await this.ssh.openInteractive(r, (chunk) => {
      void this.output
        .appendStreamOutput(id, decoder.write(chunk))
        .catch(() => {});
    });
    this.ptys.set(id, pty);
    return epoch;
  }
  async terminalInput(id: string, text: string, epoch: number): Promise<void> {
    const t = await this.store.get<ExecutionSession>("execution_sessions", id);
    requireCondition(
      t?.mode === "interactive" &&
        t.inputHolder === "local-user" &&
        t.inputEpoch === epoch &&
        Date.parse(t.inputExpiresAt ?? "") > Date.now(),
      "scope_denied",
    );
    const resource = await this.store.get<Resource>("resources", t.resourceId);
    requireCondition(
      resource && resource.identity === t.resourceIdentity,
      "identity_mismatch",
    );
    await this.grants.resolve(resource, "interactive", "local-user");
    const pty = this.ptys.get(id);
    requireCondition(pty && Buffer.byteLength(text) <= 4096, "invalid_input");
    pty.write(text);
  }
  private async executePower(
    capability: string,
    resource: Resource,
    p: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<ToolResult> {
    if (capability.startsWith("ssh.")) {
      if (capability === "ssh.propose_config")
        return toolResult({
          artifactId: await this.ssh.prepareReplacement(
            resource,
            String(p.path),
            String(p.expectedHash),
            String(p.content),
            String(p.__sessionId),
          ),
        });
      if (capability === "ssh.replace_config")
        return replaceConfigAndVerify(this.ssh, resource, p, signal, () =>
          this.checkService(resource),
        );
      return this.ssh.execute(capability, resource, p, signal);
    }
    if (capability.startsWith("k8s."))
      return this.kube.executeRead(resource, capability.slice(4), p, signal);
    if (capability.startsWith("postgres."))
      return this.postgres.queryRead(resource, capability.slice(9), signal);
    if (capability.startsWith("http-health.")) {
      const matches = (await this.store.list<Service>("services")).filter(
        (s) =>
          s.resourceBindings.some((b) => b.resourceId === resource.id) &&
          s.health,
      );
      requireCondition(
        p.serviceId || matches.length <= 1,
        "invalid_input",
        "Select the explicit service health profile",
      );
      const service = p.serviceId
        ? await this.store.get<Service>("services", String(p.serviceId))
        : matches[0];
      if (service)
        requireCondition(
          service.resourceBindings.some((b) => b.resourceId === resource.id),
          "scope_denied",
        );
      return capability.endsWith("health_window")
        ? this.http.healthWindow(resource, service?.health, signal)
        : this.http.probe(resource, service?.health, signal);
    }
    if (capability === "local-files.system.status")
      return toolResult(await hostStatus(resource, signal));
    if (capability === "local-files.file.read")
      return toolResult(await this.workspace.read(resource, String(p.path)));
    if (capability === "local-files.file.search")
      return toolResult(
        await this.workspace.search(resource, String(p.path), String(p.query)),
      );
    if (capability === "local-files.file.propose_patch")
      return toolResult({
        artifactId: await this.workspace.proposePatch(
          resource,
          String(p.path),
          String(p.expectedHash),
          String(p.content),
          String(p.__sessionId),
        ),
      });
    if (capability === "local-files.file.apply_patch")
      return toolResult(
        await this.workspace.applyPatch(
          resource,
          String(p.path),
          String(p.expectedHash),
          String(p.artifactId),
        ),
      );
    if (capability === "local-files.workspace.test")
      return toolResult(await this.sandbox.runTest(resource, signal));
    throw new LakeError("capability_unavailable");
  }
  private async checkService(resource: Resource): Promise<boolean> {
    const services = (await this.store.list<Service>("services")).filter(
      (s) =>
        s.resourceBindings.some((b) => b.resourceId === resource.id) &&
        s.health,
    );
    requireCondition(services.length === 1, "precondition_failed");
    const service = services[0]!,
      http = (await this.store.list<Resource>("resources")).find(
        (r) =>
          r.kind === "http" &&
          r.endpoint === service.health!.url &&
          service.resourceBindings.some((b) => b.resourceId === r.id),
      );
    requireCondition(http, "precondition_failed");
    return (
      (
        (
          await this.http.healthWindow(
            http,
            service.health,
            new AbortController().signal,
          )
        ).data as {
          healthy?: boolean;
        }
      ).healthy === true
    );
  }
  private async postcondition(a: Action, r: Resource): Promise<boolean> {
    if (a.capability === "local-files.file.apply_patch") {
      const patch = JSON.parse(
        await this.artifacts.read(String(a.parameters.artifactId)),
      );
      return (
        (await this.workspace.read(r, String(a.parameters.path))).hash ===
        sha256(patch.content)
      );
    }
    if (a.capability === "ssh.replace_config") {
      const artifact = JSON.parse(
        await this.artifacts.read(String(a.parameters.artifactId)),
      );
      return (
        (await this.ssh.readConfig(r, String(a.parameters.path))).hash ===
        sha256(artifact.content)
      );
    }
    if (a.capability === "ssh.service_action") {
      const result = await this.ssh.execute(
        "ssh.service_status",
        r,
        { unit: a.parameters.unit },
        new AbortController().signal,
      );
      return String((result.data as any).stdout).includes("ActiveState=active");
    }
    return false;
  }
  private async inspect(
    a: Action,
    r: Resource,
  ): Promise<"observed" | "not_observed" | "unknown"> {
    if (a.effect === "read") return "not_observed";
    if (a.capability === "ssh.replace_config") {
      const content = JSON.parse(
        await this.artifacts.read(String(a.parameters.artifactId)),
      ).content;
      const current = await this.ssh.readConfig(r, String(a.parameters.path));
      return current.hash === sha256(content)
        ? "observed"
        : current.hash === a.parameters.expectedHash
          ? "not_observed"
          : "unknown";
    }
    if (a.capability === "local-files.file.apply_patch") {
      const patch = JSON.parse(
        await this.artifacts.read(String(a.parameters.artifactId)),
      );
      const current = await this.workspace.read(r, String(a.parameters.path));
      return current.hash === sha256(patch.content)
        ? "observed"
        : current.hash === a.parameters.expectedHash
          ? "not_observed"
          : "unknown";
    }
    return "unknown";
  }
  private registerTools(): void {
    const add = (
      name: string,
      roles: ToolContext["role"][],
      schema: z.ZodType,
      description: string,
      run: (p: any, c: ToolContext) => Promise<ToolResult>,
    ) => this.catalog.register({ name, roles, schema, description, run });
    const both: ToolContext["role"][] = ["coordinator", "specialist"],
      empty = z.object({}).strict();
    add(
      "lake.context",
      ["coordinator"],
      empty,
      "Read the shared operational context",
      async (_, c) => toolResult(await this.data.agentContext(c.sessionId)),
    );
    add(
      "lake.resources",
      ["coordinator"],
      empty,
      "List task-scoped resources",
      async (_, c) => {
        const t = await this.store.get<TaskContract>("tasks", c.taskId);
        return toolResult(
          publicProjection(
            (await this.store.list<Resource>("resources")).filter((r) =>
              t?.scope.includes(r.id),
            ),
          ),
        );
      },
    );
    add(
      "service.context",
      ["coordinator"],
      z.object({ serviceId: z.uuid() }).strict(),
      "Read explicit service bindings",
      async (p, c) => {
        const service = await this.store.get<Service>("services", p.serviceId),
          session = await this.store.get<Session>("sessions", c.sessionId),
          task = await this.store.get<TaskContract>("tasks", c.taskId);
        requireCondition(
          service &&
            session &&
            task &&
            session.lakeId === service.lakeId &&
            session.environmentId === service.environmentId &&
            service.resourceBindings.every((b) =>
              task.scope.includes(b.resourceId),
            ),
          "scope_denied",
        );
        return toolResult(await this.data.serviceContext(p.serviceId));
      },
    );
    add(
      "task.plan",
      ["coordinator"],
      z
        .object({
          steps: z
            .array(
              z
                .object({
                  id: z.uuid().optional(),
                  label: z.string(),
                  dependencies: z.array(z.uuid()).default([]),
                })
                .strict(),
            )
            .max(30),
        })
        .strict(),
      "Create a shared step DAG",
      async (p, c) =>
        toolResult(await this.progress.plan(c.taskId, p.steps, c.callKey)),
    );
    add(
      "task.progress",
      both,
      empty,
      "Read the shared step ledger",
      async (_, c) =>
        toolResult(
          (await this.store.list<TaskStep>("task_steps")).filter(
            (s) => s.taskId === c.taskId,
          ),
        ),
    );
    add(
      "specialist.spawn",
      ["coordinator"],
      z
        .object({
          objective: z.string(),
          resourceIds: z.array(z.uuid()),
          stepIds: z.array(z.uuid()).default([]),
          profileId: z
            .enum([
              generalProfile.id,
              ...this.config.profiles.map((p) => p.id),
            ] as [string, ...string[]])
            .optional(),
        })
        .strict(),
      "Start a bounded specialist work order",
      async (p, c) => {
        for (const id of p.stepIds)
          requireCondition(
            (await this.store.get<TaskStep>("task_steps", id))?.taskId ===
              c.taskId,
            "scope_denied",
          );
        const run = await this.specialists.spawn(c.taskId, p, c.callKey);
        return toolResult({
          id: run.id,
          profileId: run.profileId,
          state: run.state,
          stepIds: run.workOrder.stepIds,
        });
      },
    );
    add(
      "specialist.send",
      ["coordinator"],
      z.object({ specialistId: z.uuid(), text: z.string() }).strict(),
      "Send a durable specialist instruction",
      async (p, c) => {
        const r = await this.store.get<SpecialistRun>(
          "specialist_runs",
          p.specialistId,
        );
        requireCondition(r?.sessionId === c.sessionId, "scope_denied");
        await this.specialists.send(
          p.specialistId,
          p.text,
          stableId(c.callKey),
        );
        return toolResult({ sent: true });
      },
    );
    add(
      "specialist.await",
      ["coordinator"],
      z.object({ specialistId: z.uuid() }).strict(),
      "Wait for specialist progress",
      async (p, c) => {
        const r = await this.store.get<SpecialistRun>(
          "specialist_runs",
          p.specialistId,
        );
        requireCondition(r?.sessionId === c.sessionId, "scope_denied");
        const result = await this.specialists.await(p.specialistId, c.signal);
        return toolResult(
          { id: result.id, state: result.state },
          { status: result.state.status === "waiting" ? "waiting" : "ok" },
        );
      },
    );
    add(
      "specialist.cancel",
      ["coordinator"],
      z.object({ specialistId: z.uuid() }).strict(),
      "Cancel specialist work",
      async (p, c) => {
        const r = await this.store.get<SpecialistRun>(
          "specialist_runs",
          p.specialistId,
        );
        requireCondition(r?.sessionId === c.sessionId, "scope_denied");
        await this.cancelSpecialist(p.specialistId);
        return toolResult({ cancelled: true });
      },
    );
    add(
      "evidence.query",
      both,
      empty,
      "Read current sourced observations and evidence",
      async (_, c) =>
        toolResult({
          observations: (
            await this.store.list<Observation>("observations")
          ).filter((e) => e.taskId === c.taskId),
          evidence: (await this.store.list<Evidence>("evidence")).filter(
            (e) => e.taskId === c.taskId,
          ),
        }),
    );
    add(
      "task.request_input",
      ["coordinator"],
      z.object({ question: z.string().min(1).max(2000) }).strict(),
      "Ask the user to clarify the target or missing inputs and pause immediately. Never guess a remote host from a local project directory.",
      async (p, c) => {
        const task = await this.store.get<TaskContract>("tasks", c.taskId);
        requireCondition(task, "not_found");
        await this.setTask(task, {
          status: "waiting",
          waitingReason: "waiting_user_input",
        });
        const current = await this.store.get<Session>("sessions", c.sessionId);
        requireCondition(current, "not_found");
        await this.store.transact([
          eventCommand("model.delta", current, c.actor, {
            text: p.question + "\n",
          }),
        ]);
        return toolResult(
          { reason: "waiting_user_input", question: p.question },
          { status: "waiting" },
        );
      },
    );
    add(
      "task.deliver",
      ["coordinator"],
      z.object({ summary: z.string().min(1).max(32000).optional() }).strict(),
      "Verify required criteria and deliver the final report. Include a user-facing summary with findings, measurements and limitations in the user's language.",
      async (p, c) => {
        const result = await this.gate.evaluate(c.taskId);
        if (result.status === "blocked")
          return toolResult(result, { status: "waiting" });
        const report = await buildEvidenceReport(
            this.store,
            c.taskId,
            result,
            p.summary,
          ),
          artifactId = await this.artifacts.put(
            JSON.stringify(report),
            c.sessionId,
          ),
          t = await this.store.get<TaskContract>("tasks", c.taskId);
        requireCondition(t, "not_found");
        await this.setTask(t, {
          status: result.status === "verified" ? "succeeded" : "qualified",
          reportArtifactId: artifactId,
        });
        return toolResult({ delivery: result, artifactId });
      },
    );
    add(
      "task.claim_step",
      ["specialist"],
      z
        .object({ stepId: z.uuid(), expectedRevision: z.int().positive() })
        .strict(),
      "Claim an assigned shared step using CAS",
      async (p, c) => {
        const r = await this.store.get<SpecialistRun>(
          "specialist_runs",
          c.actor,
        );
        requireCondition(
          r?.workOrder.stepIds.includes(p.stepId),
          "scope_denied",
        );
        return toolResult(
          await this.progress.claim(p.stepId, c.actor, p.expectedRevision),
        );
      },
    );
    add(
      "task.report",
      ["specialist"],
      z
        .object({
          stepId: z.uuid(),
          evidenceIds: z.array(z.uuid()),
          complete: z.boolean().default(false),
        })
        .strict(),
      "Report progress with evidence",
      async (p, c) =>
        toolResult(
          await this.progress.report(
            p.stepId,
            c.actor,
            p.evidenceIds,
            p.complete,
          ),
        ),
    );
    add(
      "skill.load",
      ["specialist"],
      z.object({ name: z.string() }).strict(),
      "Load a frozen SRE skill body",
      async (p, c) => {
        const loader = this.loaders.get(c.actor);
        requireCondition(loader, "not_found");
        return toolResult({ body: loader.load(p.name) });
      },
    );
    add(
      "power.enable",
      ["specialist"],
      z
        .object({
          powerId: z.enum(
            this.powers.project().map((p) => p.id) as [string, ...string[]],
          ),
        })
        .strict(),
      "Enable tools without granting resource permissions",
      async (p, c) => {
        await this.powers.enable(this.store, c.actor, p.powerId);
        return toolResult({ enabled: p.powerId });
      },
    );
    add(
      "terminal.open",
      ["specialist"],
      z
        .object({
          resourceId: z.uuid(),
          powerId: z.enum(
            this.powers.project().map((p) => p.id) as [string, ...string[]],
          ),
        })
        .strict(),
      "Create a session-owned managed terminal",
      async (p, c) => {
        const r = await resolveTargets(
          this.store,
          c.sessionId,
          c.taskId,
          c.actor,
          p.resourceId,
        );
        requireCondition(
          this.powers.get(p.powerId).requiredResourceKinds.includes(r.kind),
          "scope_denied",
        );
        await this.grants.resolve(r, "read", "local-user");
        return toolResult(
          await this.sessions.open(
            c.sessionId,
            r,
            p.powerId,
            stableId("terminal:" + c.callKey),
          ),
        );
      },
    );
    add(
      "terminal.attach",
      ["specialist"],
      z.object({ terminalId: z.uuid() }).strict(),
      "Attach to an existing terminal in this session",
      async (p, c) => {
        const t = await this.sessions.attach(c.sessionId, p.terminalId);
        await resolveTargets(
          this.store,
          c.sessionId,
          c.taskId,
          c.actor,
          t.resourceId,
        );
        return toolResult(t);
      },
    );
    add(
      "terminal.read",
      ["specialist"],
      z
        .object({
          terminalId: z.uuid(),
          after: z.string().regex(/^\d+$/).default("0"),
        })
        .strict(),
      "Read shared terminal output",
      async (p, c) => {
        const t = await this.sessions.attach(c.sessionId, p.terminalId);
        await resolveTargets(
          this.store,
          c.sessionId,
          c.taskId,
          c.actor,
          t.resourceId,
        );
        return toolResult(
          await this.sessions.read(c.sessionId, p.terminalId, p.after),
        );
      },
    );
    add(
      "terminal.execute",
      ["specialist"],
      z
        .object({
          terminalId: z.uuid(),
          capability: z.string(),
          parameters: z.record(z.string(), z.unknown()),
        })
        .strict(),
      "Execute an enabled fixed capability through the action gateway",
      async (p, c) => {
        const t = await this.sessions.attach(c.sessionId, p.terminalId);
        const cap = this.powers.capability(p.capability);
        const r = await this.store.get<SpecialistRun>(
          "specialist_runs",
          c.actor,
        );
        requireCondition(
          r?.powerBindings.includes(cap.manifest.id),
          "scope_denied",
        );
        return this.gateway.execute(
          {
            sessionId: c.sessionId,
            taskId: c.taskId,
            actor: c.actor,
            capability: p.capability,
            resourceId: t.resourceId,
            parameters: p.parameters,
            terminalSessionId: t.id,
            callKey: c.callKey,
          },
          c.signal,
        );
      },
    );
    add(
      "specialist.set_phase",
      ["specialist"],
      z
        .object({
          phase: z.enum([
            "collecting",
            "diagnosing",
            "planning",
            "remediating",
            "verifying",
            "observing",
            "reporting",
          ]),
          reason: z.string(),
          evidenceIds: z.array(z.uuid()).default([]),
        })
        .strict(),
      "Update the public SRE phase without changing completion",
      async (p, c) => {
        await this.state.setPhase(c.actor, p.phase);
        return toolResult({ phase: p.phase });
      },
    );
    add(
      "observation.record",
      ["specialist"],
      z.object({ resourceId: z.uuid(), value: z.unknown() }).strict(),
      "Record an unverified model claim, distinct from tool facts",
      async (p, c) => {
        await resolveTargets(
          this.store,
          c.sessionId,
          c.taskId,
          c.actor,
          p.resourceId,
        );
        return toolResult(
          await recordObservation(
            this.store,
            c.sessionId,
            c.taskId,
            p.resourceId,
            this.redactor.value(p.value),
            stableId(c.callKey),
          ),
        );
      },
    );
    add(
      "hypothesis.update",
      ["specialist"],
      z
        .object({
          id: z.uuid().optional(),
          claim: z.string(),
          status: z.enum(["candidate", "supported", "refuted"]),
          supportingEvidence: z.array(z.uuid()),
          refutingEvidence: z.array(z.uuid()),
          nextProbe: z.string(),
        })
        .strict(),
      "Maintain hypotheses and counter-evidence",
      async (p, c) =>
        toolResult(
          await updateHypothesis(this.store, {
            ...p,
            id: p.id ?? stableId(c.callKey),
            taskId: c.taskId,
            sessionId: c.sessionId,
          }),
        ),
    );
    add(
      "specialist.deliver",
      ["specialist"],
      empty,
      "Deliver scoped findings after assigned step verification",
      async (_, c) => {
        const r = await this.store.get<SpecialistRun>(
          "specialist_runs",
          c.actor,
        );
        requireCondition(r, "not_found");
        for (const id of r.workOrder.stepIds)
          requireCondition(
            (await this.store.get<TaskStep>("task_steps", id))?.status ===
              "succeeded",
            "precondition_failed",
          );
        const facts = (
          await this.store.list<Observation>("observations")
        ).filter(
          (o) =>
            o.taskId === r.taskId &&
            r.workOrder.resourceIds.includes(o.resourceId) &&
            new EvidencePolicy().isFresh(o),
        );
        requireCondition(facts.length > 0, "precondition_failed");
        await this.store.transact(
          changeCommands(
            "specialist_runs",
            {
              ...r,
              revision: r.revision + 1,
              state: {
                ...r.state,
                status: "succeeded",
                phase: "reporting",
                activity: "idle",
                revision: r.state.revision + 1,
              },
            },
            "specialist.finished",
            c.actor,
            new Date().toISOString(),
          ),
        );
        return toolResult({
          delivered: true,
          observationIds: facts.map((o) => o.id),
        });
      },
    );
    for (const manifest of this.powers.project())
      for (const tool of manifest.tools)
        this.catalog.register({
          name: manifest.id + "." + tool.name,
          description: tool.description,
          schema: powerSchemas[tool.schema]!,
          roles: tool.effect === "read" ? both : ["specialist"],
          powerId: manifest.id,
          run: (p, c) =>
            this.gateway.execute(
              {
                sessionId: c.sessionId,
                taskId: c.taskId,
                actor: c.actor,
                capability: manifest.id + "." + tool.name,
                resourceId: String(p.resourceId),
                parameters: p,
                callKey: c.callKey,
              },
              c.signal,
            ),
        });
  }
}
export async function createLakeApplication(
  options: {
    home?: string;
    config?: unknown;
    modelFactory?: (provider: Provider) => ModelPort;
    background?: boolean;
    fault?: (point: string, action: Action) => Promise<void>;
  } = {},
): Promise<LakeApplication> {
  const paths = await prepareHome(options.home);
  const lock = await acquireDaemonLock(join(paths.agent, "daemon.lock"));
  let store: SqliteStore | undefined;
  try {
    let raw = options.config;
    if (!raw) {
      try {
        raw = JSON.parse(
          await readFile(join(paths.agent, "config.json"), "utf8"),
        );
      } catch {
        raw = {
          schemaVersion: 1,
          defaultProvider: "unconfigured",
          providers: [
            {
              id: "unconfigured",
              baseUrl: "http://127.0.0.1:1/v1",
              model: "unconfigured",
              contextWindowTokens: 32768,
              maxOutputTokens: 4096,
              supportsTools: false,
            },
          ],
        };
      }
    }
    const config = ConfigSchema.parse(raw);
    store = new SqliteStore(paths.database);
    await store.transact([]);
    await chmod(paths.database, 0o600);
    const app = new LakeApplication(
      store,
      config,
      paths,
      lock,
      new Redactor(),
      options.modelFactory,
      options.fault,
    );
    await app.start(options.background);
    return app;
  } catch (error) {
    await store?.close();
    await lock.release();
    throw error;
  }
}
