import type { DataPort } from "./ports.js";
import type { LakeTool } from "../domain/agent.js";
import type { JsonValue } from "../domain/json.js";
import { object, text, type Params } from "../domain/validation.js";

export function workflowAuthoringTool(
  data: DataPort,
  conversation: Params,
  resources: Params[],
  activity: (kind: string, payload: JsonValue) => Promise<void>,
): LakeTool {
  return {
    name: "lake_workflow_save",
    description:
      "保存或修改当前会话湖的运维工作流定义，只写定义和湖志，不执行检查或命令。优先 version=2。CPU 示例 spec={version:2,name:'CPU巡检',nodes:[{id:'cpu',kind:'ssh_check',check:'cpu',target:{type:'string',literal:'当前资源名'}}]}。返回定义 ID 和 revision。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["version", "spec"],
      properties: {
        version: { type: "integer", enum: [1, 2] },
        definition_id: { type: "string", description: "修改已有定义时填写；省略表示创建" },
        expected_revision: {
          type: "integer",
          description: "修改 v2 定义必须提供查询到的 revision",
        },
        spec: {
          type: "object",
          required: ["name"],
          additionalProperties: true,
          properties: {
            name: { type: "string" },
            description: { type: "string" },
            version: { type: "integer", enum: [2] },
            max_parallel: { type: "integer", minimum: 1, maximum: 4 },
            nodes: {
              type: "array",
              minItems: 1,
              maxItems: 32,
              items: {
                type: "object",
                required: ["id", "kind"],
                properties: {
                  id: { type: "string" },
                  kind: {
                    type: "string",
                    enum: ["ssh_check", "ssh_command", "code_task", "specialist_task", "tool_call"],
                  },
                  check: { type: "string" },
                  target: {
                    type: "object",
                    description: "类型化值，如 {type:'string',literal:'当前资源名'}",
                  },
                  depends_on: { type: "array", items: { type: "string" } },
                },
              },
            },
            steps: {
              type: "array",
              description: "version=1 使用现有 steps 格式",
              items: { type: "object" },
            },
          },
        },
      },
    },
    call: async (args, signal) => {
      signal.throwIfAborted();
      const version = Number(args.version);
      if (![1, 2].includes(version)) throw new Error("工作流版本无效");
      const spec = object(args.spec),
        nodes = spec[version === 2 ? "nodes" : "steps"];
      for (const value of Array.isArray(nodes) ? nodes : []) {
        const node = object(value),
          target = version === 2 ? object(node.target).literal : node.resource;
        if (typeof target !== "string" || (version === 1 && target.startsWith("$"))) continue;
        if (
          !resources.some((resource) =>
            [resource.id, resource.name, `${conversation.lake}/${resource.name}`].includes(target),
          )
        )
          throw new Error("工作流资源不属于当前会话冻结范围");
      }
      // 复用数据层验证和修订号；创建定义不得触发执行器或建立另一个写入路径。
      const prefix = version === 2 ? "workflow.v2" : "workflow",
        id = text(args, "definition_id");
      const saved = object(
        await data.request(`${prefix}.${id ? "amend" : "save"}`, {
          lake: conversation.lake!,
          spec,
          ...(id ? { id, expected_revision: args.expected_revision! } : {}),
        }),
      );
      await activity("workflow_saved", {
        definition_id: saved.id!,
        version,
        name: saved.name!,
        lake: saved.lake!,
        revision: saved.revision ?? 0,
      });
      return saved;
    },
  };
}
