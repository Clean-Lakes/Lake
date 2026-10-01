import type { JsonValue } from "../../domain/json.js";
import type { LakeEvent } from "../../domain/protocol.js";
import { object, redact, text, type Params } from "../../domain/validation.js";

interface Reply {
  method: string;
  input: Params;
  signature: string;
  settled: boolean;
  promise: Promise<JsonValue>;
  resolve(value: JsonValue): void;
}

/** Translates native reverse RPCs to the existing UI. ZCode owns permission decisions and lifecycle. */
export class NativeInteractions {
  private readonly replies = new Map<string, Reply>();
  constructor(
    private readonly runID: string,
    private readonly emit: (event: LakeEvent) => void,
    private readonly signal: AbortSignal,
    private readonly lakeTools: ReadonlySet<string> = new Set(),
  ) {}
  async request(method: string, input: Params): Promise<JsonValue> {
    if (method === "session/requestRuntimePreferences")
      return {
        nativeSearchEnhancementsEnabled: true,
        memoryEnabled: true,
        askUserQuestionAutoResolutionEnabled: false,
        modelContextBudgetStrategy: "preflight-v1",
      };
    // These exact scoped tools enforce the Lake operations gate themselves. Native code tools retain ZCode's gate.
    if (method === "interaction/requestPermission" && this.lakeTools.has(text(input, "toolName")))
      return { decision: "allow", reason: "Delegated to Lake operations authorization" };
    if (!["interaction/requestPermission", "interaction/requestUserInput"].includes(method))
      throw new Error("当前前端没有此原生宿主能力");
    const id = text(input, "requestId");
    if (!id) throw new Error("原生交互缺少请求 ID");
    const signature = JSON.stringify([method, input]),
      previous = this.replies.get(id);
    if (previous) {
      if (previous.signature !== signature) throw new Error("原生交互 ID 冲突");
      return previous.promise;
    }
    let resolve: (value: JsonValue) => void = () => {};
    const promise = new Promise<JsonValue>((done) => {
      resolve = done;
    });
    const reply: Reply = { method, input, signature, promise, settled: false, resolve };
    this.replies.set(id, reply);
    const abort = () =>
      this.finish(
        reply,
        method === "interaction/requestPermission"
          ? { decision: "deny", reason: "任务已取消" }
          : { action: "cancel" },
      );
    this.signal.addEventListener("abort", abort, { once: true });
    void promise.finally(() => this.signal.removeEventListener("abort", abort));
    if (this.signal.aborted) abort();
    else if (method === "interaction/requestPermission")
      this.emit({
        type: "approval",
        approval_id: id,
        kind: "native",
        path: text(input, "toolName"),
        command: redact(JSON.stringify(input.input)),
        reason: text(input, "reason"),
      });
    else {
      const questions = Array.isArray(input.questions)
        ? input.questions.map(object)
        : [
            {
              question: text(input, "prompt"),
              header: text(input, "toolName", "ZCode"),
              options: [],
            },
          ];
      this.emit({
        type: "question",
        question: {
          id,
          questions: questions.map((question, index) => ({
            id: `q${index}`,
            header: text(question, "header"),
            prompt: text(question, "question"),
            ...(question.multiSelect === true ? { multiSelect: true } : {}),
            options: (Array.isArray(question.options) ? question.options : []).map((option) => ({
              label: text(object(option), "label"),
              description: text(object(option), "description"),
            })),
          })),
        },
      });
    }
    return promise;
  }
  respond(id: string, params: Params): boolean {
    const candidates = [...this.replies.values()].filter(
      (reply) =>
        !reply.settled &&
        (text(reply.input, "requestId") === id ||
          (id === this.runID && reply.method === "interaction/requestPermission")),
    );
    if (!candidates.length) return false;
    if (candidates.length !== 1) throw new Error("请使用审批请求 ID 回答");
    const reply = candidates[0]!;
    if (params.run_id && params.run_id !== this.runID) throw new Error("问题不属于当前运行");
    if (reply.method === "interaction/requestPermission")
      this.finish(reply, {
        decision: params.approved === true ? "allow" : "deny",
        reason: params.approved === true ? "Approved once" : "用户拒绝执行",
      });
    else {
      const supplied = object(params.answers),
        answers: Params = {},
        questions = Array.isArray(reply.input.questions)
          ? reply.input.questions.map(object)
          : [{ question: text(reply.input, "prompt"), options: [] }];
      questions.forEach((question, index) => {
        const answer = text(supplied, `q${index}`).trim();
        if (!answer || answer.length > 2048) throw new Error("请完整回答原生问题");
        const option = (Array.isArray(question.options) ? question.options : [])
          .map(object)
          .find((option) => option.label === answer);
        if (question.multiSelect === true && answer.startsWith("[")) {
          const selected = JSON.parse(answer);
          if (
            !Array.isArray(selected) ||
            !selected.length ||
            selected.some((label) => typeof label !== "string")
          )
            throw new Error("多选回答无效");
          answers[text(question, "question")] = selected
            .map((label) => {
              const item = (question.options as Params[]).find((option) => option.label === label);
              if (!item) throw new Error("多选回答不在原生选项中");
              return text(item, "value", label);
            })
            .join(", ");
        } else
          answers[text(question, "question")] = option ? text(option, "value", answer) : answer;
      });
      this.finish(reply, { action: "accept", content: { answers } });
      this.emit({
        type: "question_answered",
        question_id: text(reply.input, "requestId"),
        answers: supplied,
      });
    }
    return true;
  }
  private finish(reply: Reply, value: JsonValue): void {
    if (!reply.settled) {
      reply.settled = true;
      reply.resolve(value);
    }
  }
}
