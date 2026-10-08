import type {
  Resource,
  ToolResult,
  HealthProfile,
} from "../domain/entities.js";
import { toolResult } from "../domain/entities.js";
import { requireCondition, LakeError } from "../domain/errors.js";
import { HealthProfileSchema } from "../domain/schemas.js";
export class HttpProbeAdapter {
  private readonly last = new Map<string, number>();
  async probe(
    resource: Resource,
    profile: HealthProfile | undefined,
    signal: AbortSignal,
  ): Promise<ToolResult> {
    const health: HealthProfile =
      profile ?? defaultHealthProfile(resource.endpoint);
    requireCondition(
      health.url === resource.endpoint,
      "scope_denied",
      "Probe URL is not the bound resource",
    );
    const url = new URL(health.url);
    requireCondition(
      ["http:", "https:"].includes(url.protocol) &&
        !url.username &&
        !url.password,
      "scope_denied",
    );
    const previous = this.last.get(resource.id) ?? 0;
    if (Date.now() - previous < 10) await new Promise((r) => setTimeout(r, 10));
    this.last.set(resource.id, Date.now());
    try {
      const response = await fetch(url, {
        method: "GET",
        redirect: "manual",
        signal: AbortSignal.any([
          signal,
          AbortSignal.timeout(health.timeoutMs),
        ]),
      });
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        throw new LakeError("scope_denied", "Redirect is not allowed");
      }
      let bytes = 0;
      const chunks: Uint8Array[] = [];
      if (response.body) {
        const reader = response.body.getReader();
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            bytes += value.length;
            requireCondition(bytes <= 65536, "output_limit");
            chunks.push(value);
          }
        } finally {
          try {
            await reader.cancel();
          } catch {}
          reader.releaseLock();
        }
      }
      const body = Buffer.concat(chunks).toString("utf8");
      return toolResult(
        {
          status: response.status,
          healthy:
            health.statuses.includes(response.status) &&
            (!health.bodyIncludes || body.includes(health.bodyIncludes)),
          body,
          observedAt: new Date().toISOString(),
        },
        { retryPolicy: "safe_read" },
      );
    } catch (e) {
      if (e instanceof LakeError) throw e;
      throw new LakeError(signal.aborted ? "cancelled" : "timeout");
    }
  }
  async healthWindow(
    resource: Resource,
    profile: HealthProfile | undefined,
    signal: AbortSignal,
  ): Promise<ToolResult> {
    const health: HealthProfile =
      profile ?? defaultHealthProfile(resource.endpoint);
    const start = Date.now(),
      samples: unknown[] = [];
    let successes = 0;
    while (Date.now() - start < health.maxWaitMs) {
      requireCondition(!signal.aborted, "cancelled");
      try {
        const result = await this.probe(resource, health, signal);
        const data = result.data as {
          healthy: boolean;
        };
        samples.push(data);
        successes = data.healthy ? successes + 1 : 0;
        if (successes >= health.successes)
          return toolResult({ healthy: true, samples });
      } catch (e) {
        if (
          e instanceof LakeError &&
          ["scope_denied", "output_limit", "cancelled"].includes(e.code)
        )
          throw e;
        samples.push({ healthy: false, error: "probe_failed" });
        successes = 0;
      }
      await new Promise((r) =>
        setTimeout(
          r,
          Math.min(
            health.intervalMs,
            Math.max(0, health.maxWaitMs - (Date.now() - start)),
          ),
        ),
      );
    }
    return toolResult({ healthy: false, samples });
  }
}
function defaultHealthProfile(url: string): HealthProfile {
  const { bodyIncludes, ...rest } = HealthProfileSchema.parse({ url });
  return { ...rest, ...(bodyIncludes !== undefined ? { bodyIncludes } : {}) };
}
