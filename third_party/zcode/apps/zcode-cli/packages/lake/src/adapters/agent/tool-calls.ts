import type { LakeTool } from "../../domain/agent.js";
import type { JsonValue } from "../../domain/json.js";
import { object, redact, type Params } from "../../domain/validation.js";

const MAX_CALLS = 10000;
export class AgentToolCalls {
  private readonly calls = new Map<string, { input: string; result: Promise<JsonValue> }>();
  constructor(
    private readonly tools: LakeTool[],
    private readonly apiKey: Buffer,
    private readonly signal: AbortSignal,
  ) {}
  call(id: JsonValue, params: Params): Promise<JsonValue> {
    if (typeof id !== "string" && typeof id !== "number") throw new Error("无效的 MCP 请求 ID");
    const key = JSON.stringify(id),
      input = JSON.stringify(params),
      previous = this.calls.get(key);
    // MCP 重试必须复用同一结果；相同 ID 换参数不能再次执行已批准的操作。
    if (previous) {
      if (previous.input !== input) throw new Error("重复工具请求 ID 的输入不同");
      return previous.result;
    }
    if (this.calls.size >= MAX_CALLS) throw new Error("本回合工具请求记录已满");
    const result = this.execute(params);
    this.calls.set(key, { input, result });
    return result;
  }
  private async execute(params: Params): Promise<JsonValue> {
    const tool = this.tools.find((candidate) => candidate.name === params.name);
    if (!tool) throw new Error("工具未注册");
    try {
      this.signal.throwIfAborted();
      const value = await tool.call(object(params.arguments), this.signal);
      const body = redact(
        JSON.stringify(value).replaceAll(this.apiKey.toString(), "[redacted]"),
        256 * 1024,
      );
      const status =
        value && typeof value === "object" && !Array.isArray(value) ? value.status : undefined;
      return {
        content: [{ type: "text", text: body }],
        isError: status === "failed" || status === "unknown",
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: redact(error instanceof Error ? error.message : String(error)).replaceAll(
              this.apiKey.toString(),
              "[redacted]",
            ),
          },
        ],
        isError: true,
      };
    }
  }
}
