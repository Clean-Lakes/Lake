import { object, text, type Params } from "./validation.js";

/** 原生失败携带明确错误码；固定文案避免把 provider 正文、凭据或堆栈传给前端。 */
export function nativeTurnFailure(payload: Params): Error {
  const error = object(payload.error),
    code = text(error, "code", text(error, "type")).toUpperCase();
  const messages: Record<string, string> = {
    MODEL_CONTEXT_EXCEEDED:
      "LAKE 会话上下文超过模型容量。请在新会话继续，或核对模型设置中的上下文窗口。已完成检查已保留，不会自动重跑。",
    MODEL_AUTH_FAILED: "LAKE 模型认证失败，请检查模型凭据。",
    MODEL_RATE_LIMITED: "LAKE 模型服务达到请求限额，请稍后继续。",
    MODEL_TIMEOUT: "LAKE 模型请求超时；已完成的操作不会自动重跑。",
    SESSION_CANCELLED: "任务已取消。",
  };
  return new Error(
    messages[code] ?? "LAKE 模型任务失败，请检查模型配置与连接。已完成的操作不会自动重跑。",
  );
}
