import type {
  ModelPort,
  ModelRequest,
  ModelEvent,
  ModelUsage,
  ToolCall,
  ModelMessage,
} from "../../domain/ports.js";
import type { Provider } from "../../domain/config.js";
import type { CredentialPort } from "../../domain/ports.js";
import { LakeError, requireCondition } from "../../domain/errors.js";
import { parseSse } from "./sse-parser.js";
function usage(value: any): ModelUsage | null {
  if (!value) return null;
  const input = value.prompt_tokens,
    output = value.completion_tokens;
  if (
    !Number.isSafeInteger(input) ||
    input < 0 ||
    !Number.isSafeInteger(output) ||
    output < 0
  )
    return null;
  const cached = value.prompt_tokens_details?.cached_tokens;
  return {
    input,
    output,
    cached: Number.isSafeInteger(cached) && cached >= 0 ? cached : null,
  };
}
export class ChatModelAdapter implements ModelPort {
  constructor(
    readonly provider: Provider,
    private readonly credentials: CredentialPort,
    private readonly timeoutMs = 120000,
  ) {}
  async *stream(request: ModelRequest): AsyncGenerator<ModelEvent> {
    requireCondition(
      this.provider.supportsTools,
      "capability_unavailable",
      "Configured model does not support tools",
    );
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.provider.credentialRef) {
      const key = await this.credentials.resolve(this.provider.credentialRef);
      headers.Authorization = "Bearer " + Buffer.from(key).toString().trim();
      key.fill(0);
    }
    const streaming = this.provider.supportsStreaming;
    const body = {
      model: this.provider.model,
      messages: request.messages,
      ...(request.tools.length
        ? { tools: request.tools, tool_choice: "auto" }
        : {}),
      stream: streaming,
      max_tokens: request.maxOutputTokens,
      ...(streaming && this.provider.supportsUsageInStream
        ? { stream_options: { include_usage: true } }
        : {}),
    };
    let response: Response;
    try {
      response = await fetch(
        this.provider.baseUrl.replace(/\/$/, "") + "/chat/completions",
        {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          redirect: "error",
          signal: AbortSignal.any([
            request.signal,
            AbortSignal.timeout(this.timeoutMs),
          ]),
        },
      );
    } catch {
      throw new LakeError(request.signal.aborted ? "cancelled" : "timeout");
    } finally {
      delete headers.Authorization;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new LakeError(
        "model_protocol_error",
        `Model HTTP ${response.status}`,
        response.status === 429 || response.status >= 500,
      );
    }
    if (!streaming) {
      const data = (await response.json()) as any;
      const choice = data.choices?.[0];
      requireCondition(
        choice && ["stop", "tool_calls"].includes(choice.finish_reason),
        "model_protocol_error",
      );
      const m = choice.message;
      const calls = this.validateCalls(m.tool_calls ?? []);
      yield {
        type: "complete",
        message: {
          role: "assistant",
          content: typeof m.content === "string" ? m.content : null,
          ...(calls.length ? { tool_calls: calls } : {}),
        },
        usage: usage(data.usage),
      };
      return;
    }
    requireCondition(response.body, "model_protocol_error");
    let text = "",
      finished = false,
      done = false,
      meter: ModelUsage | null = null;
    const calls = new Map<
      number,
      {
        id: string;
        name: string;
        arguments: string;
      }
    >();
    try {
      for await (const data of parseSse(response.body)) {
        if (data === "[DONE]") {
          done = true;
          break;
        }
        let chunk: any;
        try {
          chunk = JSON.parse(data);
        } catch {
          throw new LakeError("model_protocol_error");
        }
        if (chunk.usage) meter = usage(chunk.usage);
        const choice = chunk.choices?.[0];
        if (!choice) continue;
        const delta = choice.delta ?? {};
        if (typeof delta.content === "string") {
          text += delta.content;
          requireCondition(Buffer.byteLength(text) <= 1048576, "output_limit");
          yield { type: "text", text: delta.content };
        }
        for (const call of delta.tool_calls ?? []) {
          requireCondition(
            Number.isSafeInteger(call.index) &&
              call.index >= 0 &&
              call.index < 32,
            "model_protocol_error",
          );
          const entry = calls.get(call.index) ?? {
            id: "",
            name: "",
            arguments: "",
          };
          if (call.id) entry.id += call.id;
          if (call.function?.name) entry.name += call.function.name;
          if (call.function?.arguments)
            entry.arguments += call.function.arguments;
          requireCondition(entry.arguments.length <= 262144, "output_limit");
          calls.set(call.index, entry);
        }
        if (choice.finish_reason) {
          requireCondition(
            ["stop", "tool_calls"].includes(choice.finish_reason),
            "model_protocol_error",
            "Incomplete model response",
          );
          finished = true;
        }
      }
    } catch (error) {
      if (error instanceof LakeError) throw error;
      throw new LakeError(
        request.signal.aborted ? "cancelled" : "model_protocol_error",
      );
    }
    requireCondition(
      finished && done,
      "model_protocol_error",
      "Model stream did not finish",
    );
    const toolCalls = this.validateCalls(
      [...calls]
        .sort(([a], [b]) => a - b)
        .map(([, c]) => ({
          id: c.id,
          type: "function",
          function: { name: c.name, arguments: c.arguments },
        })),
    );
    yield {
      type: "complete",
      message: {
        role: "assistant",
        content: text || null,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      },
      usage: meter,
    };
  }
  private validateCalls(calls: any[]): ToolCall[] {
    const ids = new Set<string>();
    return calls.map((c) => {
      requireCondition(
        typeof c.id === "string" &&
          c.id.length > 0 &&
          !ids.has(c.id) &&
          c.type === "function" &&
          /^[A-Za-z0-9_-]{1,64}$/.test(c.function?.name) &&
          typeof c.function?.arguments === "string",
        "model_protocol_error",
      );
      ids.add(c.id);
      try {
        const p = JSON.parse(c.function.arguments);
        requireCondition(
          p && typeof p === "object" && !Array.isArray(p),
          "model_protocol_error",
        );
      } catch {
        throw new LakeError("model_protocol_error", "Invalid tool parameters");
      }
      return c as ToolCall;
    });
  }
}
