import type { SkillSnapshot } from "../domain/entities.js";
import { requireCondition } from "../domain/errors.js";
export class SkillLoader {
  private readonly loaded = new Set<string>();
  constructor(private readonly snapshot: SkillSnapshot[]) {}
  load(name: string): string {
    const skill = this.snapshot.find(
      (s) => s.name === name || s.name + "@" + s.version === name,
    );
    requireCondition(skill, "not_found");
    this.loaded.add(skill.digest);
    return skill.body;
  }
  bodies(): string[] {
    return this.snapshot
      .filter((s) => this.loaded.has(s.digest))
      .map((s) => s.body);
  }
  restore(digests: string[]): void {
    for (const digest of digests) {
      requireCondition(
        this.snapshot.some((s) => s.digest === digest),
        "precondition_failed",
      );
      this.loaded.add(digest);
    }
  }
  digests(): string[] {
    return [...this.loaded];
  }
}
