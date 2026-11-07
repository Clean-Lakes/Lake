import type { SessionId, SessionStorePort } from "./sdk";
import {
  isLiteralProgramDiscovery,
  compileNobodyInspection,
} from "../../web-agent/shared/command-policy";
import { boundResourceRevision } from "./resource-pin";
import { HttpError, LakeStore, now } from "./store";
import { digest, type Goal, type Operation } from "./tasks";

type Receipt = {
  method: "literal_program_discovery_v1" | "operator_nobody_inventory_v1";
  evidenceOperationId?: string;
  evidenceHash?: string;
  evidenceExecutionHash?: string;
  sourceKind?: "user_action";
  note?: string;
  operationId: string;
  operationHash: string;
  executionHash: string;
  inputHash: string;
  sourcePartId: string;
  sourceMessageId: string;
  sourceHash: string;
  verifiedAt: string;
  effects: "none";
};

/** A host-only compatibility reconciliation. Original results never change. */
export class ProgramDiscoveryRecovery {
  constructor(
    readonly store: LakeStore,
    readonly sessions: Pick<SessionStorePort, "getSession" | "messages">,
  ) {}

  private candidate(operation: Operation) {
    if (
      operation.tool !== "Bash" ||
      operation.status !== "unknown" ||
      operation.readOnly !== false ||
      !operation.commandExecutionId ||
      !operation.resourceId ||
      !operation.hostConfigurationHash ||
      operation.agentRunId ||
      operation.childSessionId ||
      operation.originalCallId ||
      operation.id !== digest([operation.sessionId, operation.callId]) ||
      operation.commandExecutionId !==
        digest([operation.goalId, operation.generation, operation.callId])
    )
      return;
    const goal = this.store.get<Goal>("superGoals", operation.goalId);
    const execution = this.store.get<any>(
      "commandExecutions",
      operation.commandExecutionId,
    );
    const result = execution?.result,
      output = operation.output as any;
    if (
      !goal ||
      goal.projectId !== operation.projectId ||
      goal.sessionId !== operation.sessionId ||
      !execution ||
      execution.taskId !== operation.goalId ||
      execution.sessionId !== operation.sessionId ||
      execution.generation !== operation.generation ||
      execution.resourceId !== operation.resourceId ||
      execution.resourceRevision !== operation.resourceRevision ||
      execution.configurationRevision !== operation.hostConfigurationHash ||
      execution.readOnly !== false ||
      execution.status !== "failed" ||
      !execution.finishedAt ||
      result?.status !== "failed" ||
      result.exitCode !== 1 ||
      result.cancelled !== false ||
      result.timedOut !== false ||
      !operation.completedAt ||
      !operation.outputHash ||
      digest(output) !== operation.outputHash ||
      output?.status !== "failed" ||
      output.exitCode !== 1 ||
      output.cancelled !== false ||
      output.timedOut !== false ||
      typeof result.stdout?.text !== "string" ||
      typeof result.stderr?.text !== "string" ||
      result.stdout.truncated !== false ||
      result.stderr.truncated !== false ||
      output.stdout !== result.stdout.text ||
      output.stderr !== result.stderr.text
    )
      return;
    return execution;
  }

  resolution(operation: Operation): Receipt | undefined {
    const execution = this.candidate(operation);
    const receipt = this.store.get<Receipt>(
      "commandReadReconciliations",
      operation.id,
    );
    if (
      execution &&
      (receipt?.method === "literal_program_discovery_v1" ||
        (receipt?.method === "operator_nobody_inventory_v1" &&
          this.matchesVerification(operation, receipt))) &&
      receipt.effects === "none" &&
      receipt.operationId === operation.id &&
      receipt.operationHash === digest(operation) &&
      receipt.executionHash === digest(execution) &&
      receipt.inputHash === operation.argsHash
    )
      return receipt;
  }

  private matchesInputRevision(operation: Operation, supplied: unknown) {
    return (
      !!operation.resourceId &&
      !!operation.hostConfigurationHash &&
      boundResourceRevision(
        this.store,
        { id: operation.resourceId, projectId: operation.projectId },
        supplied,
        operation.hostConfigurationHash,
      )
    );
  }

  private matchesVerification(original: Operation, receipt: Receipt) {
    if (receipt.sourceKind !== "user_action" || !receipt.evidenceOperationId)
      return false;
    const evidence = this.store.get<Operation>(
      "superOperations",
      receipt.evidenceOperationId,
    );
    const execution =
      evidence?.commandExecutionId &&
      this.store.get("commandExecutions", evidence.commandExecutionId);
    return (
      !!execution &&
      !!evidence &&
      evidence.projectId === original.projectId &&
      evidence.resourceId === original.resourceId &&
      evidence.status === "succeeded" &&
      evidence.readOnly === true &&
      digest(evidence) === receipt.evidenceHash &&
      digest(execution) === receipt.evidenceExecutionHash
    );
  }

  private async inventorySource(operation: Operation, execution: any) {
    const scope = compileNobodyInspection(execution.command ?? "");
    const output = operation.output as any,
      goal = this.store.get<Goal>("superGoals", operation.goalId);
    const event =
      goal &&
      this.store.get<{
        projectId: string;
        messageId: string;
        sessionId: string;
        payload: string;
        selectedReferences?: { resourceIds: string[] };
      }>("superInputs", goal.sourceEventId);
    const resource = this.store.get<{ projectId: string; kind: string }>(
      "resources",
      operation.resourceId!,
    );
    if (
      scope?.inventoryDepth == null ||
      execution.workerId !== goal?.workerId ||
      execution.id !== operation.commandExecutionId ||
      resource?.kind !== "ssh" ||
      resource.projectId !== operation.projectId ||
      event?.projectId !== operation.projectId ||
      !event.payload.includes(scope.directory) ||
      !event.selectedReferences?.resourceIds.includes(operation.resourceId!) ||
      !/^find: failed to restore initial working directory: Permission denied\n?$/.test(
        output.stderr,
      ) ||
      !/^uid=\d+\(nobody\) gid=\d+\([\w-]+\)/.test(output.stdout) ||
      !output.stdout
        .split("\n")
        .some(
          (line: string) =>
            line.startsWith("d ") && line.endsWith(" " + scope.directory),
        ) ||
      output.interrupted !== false ||
      output.stdoutTruncated !== false ||
      output.stderrTruncated !== false ||
      output.stdoutBytes !== Buffer.byteLength(output.stdout) ||
      output.stderrBytes !== Buffer.byteLength(output.stderr) ||
      execution.result.stdout.bytes !== output.stdoutBytes ||
      execution.result.stderr.bytes !== output.stderrBytes ||
      !Number.isFinite(Date.parse(execution.finishedAt)) ||
      execution.commandHash !== digest(execution.command)
    )
      return;
    const sessionId = operation.sessionId as SessionId,
      session = await this.sessions.getSession(sessionId);
    if (
      !session ||
      session.id !== sessionId ||
      session.projectID !== operation.projectId ||
      session.time.deleted
    )
      return;
    const messages = await this.sessions.messages({ sessionID: sessionId });
    const parts = messages
      .filter(
        (m) => m.info.sessionID === sessionId && m.info.role === "assistant",
      )
      .flatMap((m) =>
        m.parts.filter(
          (part) =>
            part.messageID === m.info.id &&
            part.type === "tool" &&
            part.tool === "Bash" &&
            part.callID === operation.callId,
        ),
      );
    const part = parts[0];
    if (
      parts.length !== 1 ||
      !part ||
      part.type !== "tool" ||
      part.sessionID !== sessionId ||
      part.state.status !== "completed"
    )
      return;
    const input = part.state.input;
    if (
      input.asset_ref !== operation.resourceId ||
      !this.matchesInputRevision(operation, input.configuration_revision) ||
      input.command !== execution.command ||
      input.cwd != null ||
      input.run_in_background === true ||
      input.dangerouslyDisableSandbox === true ||
      digest(input) !== operation.argsHash ||
      part.state.output !==
        ["Exit code 1", output.stdout.trimEnd(), output.stderr.trimEnd()].join(
          "\n",
        )
    )
      return;
    return {
      directory: scope.directory,
      depth: scope.inventoryDepth,
      sourcePartId: part.id,
      sourceMessageId: part.messageID,
      sourceHash: digest(part),
    };
  }

  private inventoryEvidence(
    original: Operation,
    directory: string,
    depth: number,
  ) {
    return this.store.list<Operation>("superOperations").flatMap((op) => {
      if (
        op.tool !== "Bash" ||
        !op.commandExecutionId ||
        op.status !== "succeeded" ||
        op.readOnly !== true ||
        op.agentRunId ||
        op.childSessionId ||
        op.id !== digest([op.sessionId, op.callId]) ||
        op.commandExecutionId !==
          digest([op.goalId, op.generation, op.callId]) ||
        op.projectId !== original.projectId ||
        op.resourceId !== original.resourceId ||
        op.resourceRevision !== original.resourceRevision ||
        op.hostConfigurationHash !== original.hostConfigurationHash ||
        !(Date.parse(op.at) > Date.parse(original.completedAt!)) ||
        !(Date.parse(op.completedAt ?? "") >= Date.parse(op.at))
      )
        return [];
      const run = this.store.get<any>(
          "commandExecutions",
          op.commandExecutionId,
        ),
        goal = this.store.get<Goal>("superGoals", op.goalId),
        output = op.output as any;
      if (
        !run ||
        run.nobodyInspection?.directory !== directory ||
        run.nobodyInspection.inventoryDepth !== depth ||
        !goal ||
        goal.projectId !== op.projectId ||
        goal.sessionId !== op.sessionId ||
        goal.workerId !== run.workerId ||
        run.id !== op.commandExecutionId ||
        run.taskId !== op.goalId ||
        run.sessionId !== op.sessionId ||
        run.generation !== op.generation ||
        run.resourceId !== original.resourceId ||
        run.resourceRevision !== original.resourceRevision ||
        run.configurationRevision !== original.hostConfigurationHash ||
        run.readOnly !== true ||
        run.status !== "completed" ||
        !run.finishedAt ||
        run.result?.status !== "completed" ||
        run.result?.exitCode !== 0 ||
        run.result.cancelled !== false ||
        run.result.timedOut !== false ||
        run.result.stdout?.truncated !== false ||
        run.result.stderr?.truncated !== false ||
        !output ||
        output.status !== "completed" ||
        output.exitCode !== 0 ||
        output.interrupted !== false ||
        output.cancelled !== false ||
        output.timedOut !== false ||
        output.stdoutTruncated !== false ||
        output.stderrTruncated !== false ||
        output.stdout !== run.result.stdout.text ||
        output.stderr !== "" ||
        run.result.stderr.text !== "" ||
        run.result.stdout.bytes !== Buffer.byteLength(output.stdout) ||
        output.stdoutBytes !== run.result.stdout.bytes ||
        run.result.stderr.bytes !== 0 ||
        output.stderrBytes !== 0 ||
        !op.outputHash ||
        digest(output) !== op.outputHash ||
        !/^uid=\d+\(nobody\)/.test(output.stdout) ||
        !output.stdout
          .split("\n")
          .some(
            (line: string) =>
              line.startsWith("d ") && line.endsWith(" " + directory),
          )
      )
        return [];
      // Match the actual compiled command. Matching directory and profile text
      // alone cannot qualify another inspection, result or captured output.
      const source =
        "runuser -u nobody -- /bin/bash -c 'id; ls -la " +
        directory +
        "; find " +
        directory +
        " -maxdepth " +
        depth +
        ' -printf "%y %s %p\\n"' +
        String.fromCharCode(39);
      const compiled = compileNobodyInspection(source);
      if (
        !compiled ||
        run.command !== compiled.command ||
        run.commandHash !== digest(compiled.command)
      )
        return [];
      return [
        {
          operationId: op.id,
          taskId: op.goalId,
          sessionId: op.sessionId,
          at: op.completedAt!,
          command: source,
          summary:
            "同一 SSH 资源上以 nobody 成功核查 " +
            directory +
            "，扫描深度 " +
            depth +
            "，退出码 0，标准错误为空。",
          operationHash: digest(op),
          executionHash: digest(run),
        },
      ];
    });
  }

  private async review(sessionId: string, operationId: string) {
    const session = this.store.session(sessionId),
      operation = this.store.require<Operation>("superOperations", operationId);
    if (
      operation.sessionId !== sessionId ||
      operation.projectId !== session.projectId
    )
      throw new HttpError(404, "操作不属于当前执行会话");
    const run = this.candidate(operation),
      source = run && (await this.inventorySource(operation, run));
    if (!run || !source) return;
    const still = this.store.get<Operation>("superOperations", operationId);
    if (
      !still ||
      digest(still) !== digest(operation) ||
      digest(this.candidate(still)) !== digest(run)
    )
      throw new HttpError(409, "原操作或执行回执发生变化");
    const evidence = this.inventoryEvidence(
      operation,
      source.directory,
      source.depth,
    );
    const revision = digest([
      digest(operation),
      digest(run),
      source.sourceHash,
      evidence.map((row) => [
        row.operationId,
        row.operationHash,
        row.executionHash,
      ]),
    ]);
    return { operation, run, source, evidence, revision };
  }

  async reviewInfo(sessionId: string, operationId: string) {
    const entry = await this.review(sessionId, operationId);
    if (!entry)
      return {
        operationId,
        eligible: false,
        evidence: [],
        reason: "原命令及回执不满足目录巡检人工核实条件",
      };
    if (this.resolution(entry.operation))
      return { operationId, eligible: false, resolved: true, evidence: [] };
    const { evidence, revision, source, run } = entry;
    return {
      operationId,
      eligible: true,
      revision,
      directory: source.directory,
      command: run.command,
      reason:
        "原目录检查返回工作目录权限错误。请独立核对原执行和同目标重采证据，再判断是否发生写入。",
      evidence: evidence.map(
        ({ operationHash, executionHash, ...publicEvidence }) => publicEvidence,
      ),
    };
  }

  async confirmInventoryReview(
    sessionId: string,
    operationId: string,
    input: Record<string, unknown>,
    revalidate: (
      executionId: string,
      goalId: string,
      generation: number,
    ) => void,
  ) {
    if (
      input.confirmNoWrite !== true ||
      typeof input.note !== "string" ||
      !input.note.trim() ||
      input.note.length > 2000 ||
      typeof input.evidenceOperationId !== "string" ||
      typeof input.revision !== "string"
    )
      throw new HttpError(400, "请确认未发生写入，填写核实理由并选择重采证据");
    const note = input.note.trim(),
      entry = await this.review(sessionId, operationId);
    if (!entry || input.revision !== entry.revision)
      throw new HttpError(409, "原始记录或重采证据已变化，请重新核实");
    const proof = entry.evidence.find(
      (row) => row.operationId === input.evidenceOperationId,
    );
    if (!proof)
      throw new HttpError(
        409,
        "需要同一资源、版本、目录及扫描深度的成功复测回执",
      );
    return this.store.transaction(() => {
      const op = this.store.require<Operation>("superOperations", operationId),
        run = this.candidate(op);
      if (
        !run ||
        digest(op) !== digest(entry.operation) ||
        digest(run) !== digest(entry.run)
      )
        throw new HttpError(409, "原始证据已变化");
      const verified = this.inventoryEvidence(
        op,
        entry.source.directory,
        entry.source.depth,
      ).find((row) => row.operationId === proof.operationId);
      if (
        !verified ||
        verified.operationHash !== proof.operationHash ||
        verified.executionHash !== proof.executionHash
      )
        throw new HttpError(409, "重采证据已变化");
      const fresh = this.store.require<Operation>(
        "superOperations",
        proof.operationId,
      );
      revalidate(fresh.commandExecutionId!, fresh.goalId, fresh.generation);
      if (!this.resolution(op))
        this.store.put<Receipt>("commandReadReconciliations", op.id, {
          method: "operator_nobody_inventory_v1",
          effects: "none",
          sourceKind: "user_action",
          operationId: op.id,
          operationHash: digest(op),
          executionHash: digest(run),
          inputHash: op.argsHash,
          sourcePartId: entry.source.sourcePartId,
          sourceMessageId: entry.source.sourceMessageId,
          sourceHash: entry.source.sourceHash,
          verifiedAt: now(),
          note,
          evidenceOperationId: proof.operationId,
          evidenceHash: proof.operationHash,
          evidenceExecutionHash: proof.executionHash,
        });
      return { operationId, resolved: true };
    });
  }

  async verify(projectId?: string) {
    let verified = 0;
    const messages = new Map<
      string,
      Awaited<ReturnType<SessionStorePort["messages"]>>
    >();
    for (const operation of this.store.list<Operation>("superOperations")) {
      if (
        (projectId && operation.projectId !== projectId) ||
        this.resolution(operation)
      )
        continue;
      const execution = this.candidate(operation);
      if (!execution) continue;
      const sessionId = operation.sessionId as SessionId;
      const session = await this.sessions.getSession(sessionId);
      if (
        !session ||
        session.id !== sessionId ||
        session.projectID !== operation.projectId ||
        session.time.deleted
      )
        continue;
      if (!messages.has(sessionId))
        messages.set(
          sessionId,
          await this.sessions.messages({ sessionID: sessionId }),
        );
      const parts = messages
        .get(sessionId)!
        .flatMap((message) =>
          message.info.sessionID === sessionId &&
          message.info.role === "assistant"
            ? message.parts.filter((part) => part.messageID === message.info.id)
            : [],
        )
        .filter(
          (part) =>
            part.type === "tool" &&
            part.tool === "Bash" &&
            part.callID === operation.callId,
        );
      if (parts.length !== 1) continue;
      const part = parts[0]!;
      if (
        part.type !== "tool" ||
        part.sessionID !== sessionId ||
        part.state.status !== "completed"
      )
        continue;
      const input = part.state.input;
      if (
        digest(input) !== operation.argsHash ||
        typeof input.command !== "string" ||
        (input.asset_ref !== undefined &&
          (input.asset_ref !== operation.resourceId ||
            !this.matchesInputRevision(
              operation,
              input.configuration_revision,
            ))) ||
        digest(input.command) !== execution.commandHash ||
        !isLiteralProgramDiscovery(input.command)
      )
        continue;
      // Async archive reads never authorize a stale operation or execution.
      this.store.transaction(() => {
        const current = this.store.require<Operation>(
          "superOperations",
          operation.id,
        );
        if (
          this.resolution(current) ||
          digest(current) !== digest(operation) ||
          digest(this.candidate(current)) !== digest(execution)
        )
          return;
        this.store.put<Receipt>("commandReadReconciliations", operation.id, {
          method: "literal_program_discovery_v1",
          operationId: operation.id,
          operationHash: digest(operation),
          executionHash: digest(execution),
          inputHash: digest(input),
          sourcePartId: part.id,
          sourceMessageId: part.messageID,
          sourceHash: digest(part),
          effects: "none",
          verifiedAt: now(),
        });
        verified++;
      });
    }
    return verified;
  }
}
