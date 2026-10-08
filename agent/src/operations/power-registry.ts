import type { StorePort } from "../domain/ports.js";
import type { SpecialistRun } from "../domain/entities.js";
import { requireCondition } from "../domain/errors.js";
import { changeCommands } from "../domain/events.js";
import {
  PowerManifestSchema,
  type PowerManifest,
  powerSchemas,
} from "./power-manifest.js";
export class PowerRegistry {
  private readonly manifests = new Map<string, PowerManifest>();
  register(input: unknown): void {
    const manifest = PowerManifestSchema.parse(input);
    requireCondition(
      manifest.adapterFactory === manifest.id &&
        !this.manifests.has(manifest.id),
      "conflict",
    );
    for (const tool of manifest.tools)
      requireCondition(
        powerSchemas[tool.schema] &&
          manifest.effectPolicies[tool.name] === tool.effect,
        "invalid_input",
      );
    this.manifests.set(manifest.id, manifest);
  }
  get(id: string): PowerManifest {
    const m = this.manifests.get(id);
    requireCondition(m, "capability_unavailable");
    return m;
  }
  capability(name: string) {
    for (const m of this.manifests.values()) {
      const t = m.tools.find((t) => m.id + "." + t.name === name);
      if (t) return { manifest: m, tool: t, schema: powerSchemas[t.schema]! };
    }
    throw new Error("Unknown capability");
  }
  project(): PowerManifest[] {
    return structuredClone([...this.manifests.values()]);
  }
  async enable(store: StorePort, actor: string, id: string): Promise<void> {
    this.get(id);
    const run = await store.get<SpecialistRun>("specialist_runs", actor);
    requireCondition(run, "scope_denied");
    if (run.powerBindings.includes(id)) return;
    await store.transact(
      changeCommands(
        "specialist_runs",
        {
          ...run,
          revision: run.revision + 1,
          powerBindings: [...run.powerBindings, id],
        },
        "specialist.state_changed",
        actor,
        new Date().toISOString(),
      ),
    );
  }
}
