import type {
  Resource,
  HealthProfile,
  ToolResult,
} from "../domain/entities.js";
export async function verifyHttpService(
  probe: {
    healthWindow(
      resource: Resource,
      profile: HealthProfile | undefined,
      signal: AbortSignal,
    ): Promise<ToolResult>;
  },
  resource: Resource,
  profile: HealthProfile | undefined,
  signal: AbortSignal,
): Promise<ToolResult> {
  return probe.healthWindow(resource, profile, signal);
}
