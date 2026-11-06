import type { SessionId, SessionStorePort } from "./sdk";
import { isLiteralProgramDiscovery } from "../../web-agent/shared/command-policy";
import { LakeStore, now } from "./store";
import { digest, type Goal, type Operation } from "./tasks";

type Receipt = {
  method: "literal_program_discovery_v1";
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
      receipt?.method === "literal_program_discovery_v1" &&
      receipt.effects === "none" &&
      receipt.operationId === operation.id &&
      receipt.operationHash === digest(operation) &&
      receipt.executionHash === digest(execution) &&
      receipt.inputHash === operation.argsHash
    )
      return receipt;
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
            input.configuration_revision !==
              operation.hostConfigurationHash)) ||
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
