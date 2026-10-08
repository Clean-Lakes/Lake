import { z } from "zod";
import type { ToolDefinition } from "../domain/ports.js";
import type { ToolResult } from "../domain/entities.js";
import { LakeError, requireCondition } from "../domain/errors.js";
export interface ToolContext {
  sessionId: string;
  taskId: string;
  actor: string;
  role: "coordinator" | "specialist";
  powerBindings: string[];
  callKey: string;
  signal: AbortSignal;
}
export interface ToolSpec {
  name: string;
  description: string;
  schema: z.ZodType;
  roles: ToolContext["role"][];
  powerId?: string;
  run: (
    parameters: Record<string, unknown>,
    context: ToolContext,
  ) => Promise<ToolResult>;
}
export function wireName(name: string): string {
  return name.replace(/[.-]/g, "_");
}
export class ToolCatalog {
  private readonly specs = new Map<string, ToolSpec>();
  register(spec: ToolSpec): void {
    const key = wireName(spec.name);
    requireCondition(
      /^[A-Za-z0-9_]{1,64}$/.test(key) && !this.specs.has(key),
      "conflict",
    );
    this.specs.set(key, spec);
  }
  project(
    context: Pick<ToolContext, "role" | "powerBindings">,
  ): ToolDefinition[] {
    return [...this.specs]
      .sort(([a], [b]) => a.localeCompare(b))
      .filter(
        ([, s]) =>
          s.roles.includes(context.role) &&
          (!s.powerId || context.powerBindings.includes(s.powerId)),
      )
      .map(([name, s]) => ({
        type: "function",
        function: {
          name,
          description: s.name + ": " + s.description,
          parameters: z.toJSONSchema(s.schema, {
            unrepresentable: "any",
          }) as Record<string, unknown>,
        },
      }));
  }
  resolve(name: string, context: ToolContext): ToolSpec {
    const spec = this.specs.get(name);
    if (!spec) throw new LakeError("invalid_input", "Unknown tool");
    requireCondition(
      spec.roles.includes(context.role) &&
        (!spec.powerId || context.powerBindings.includes(spec.powerId)),
      "scope_denied",
    );
    return spec;
  }
}
