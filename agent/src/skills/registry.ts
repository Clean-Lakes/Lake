import { parseDocument } from "yaml";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { SkillSnapshot } from "../domain/entities.js";
import { requireCondition } from "../domain/errors.js";
export const defaultSkillNames = [
  "sre-diagnosis",
  "sre-coding",
  "sre-deployment",
  "sre-debugging",
  "sre-verification",
  "sre-reporting",
];
export function composeDefaultSkills(extra: string[] = []): string[] {
  return [...new Set([...defaultSkillNames, ...extra])];
}
const Meta = z
  .object({
    name: z.string().regex(/^[a-z][a-z0-9-]+$/),
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    description: z.string().min(1),
    whenToUse: z.string().min(1),
  })
  .strict();
export class SkillRegistry {
  private readonly skills = new Map<string, SkillSnapshot>();
  register(text: string, source: string, builtin = false): void {
    const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(text);
    requireCondition(match, "invalid_input", "Skill front matter required");
    const document = parseDocument(match[1]!, { customTags: [] });
    requireCondition(!document.errors.length, "invalid_input");
    const meta = Meta.parse(document.toJSON());
    requireCondition(
      builtin || !defaultSkillNames.includes(meta.name),
      "scope_denied",
      "Builtin skills cannot be overridden",
    );
    const digest = createHash("sha256").update(text).digest("hex"),
      key = meta.name + "@" + meta.version,
      old = this.skills.get(key);
    requireCondition(
      !old || old.digest === digest,
      "conflict",
      "Skill version content mismatch",
    );
    this.skills.set(key, { ...meta, body: match[2]!, digest, source });
  }
  resolve(extra: string[] = []): SkillSnapshot[] {
    const resolved = composeDefaultSkills(extra).map((name) => {
      const candidates = [...this.skills.values()].filter(
        (s) => s.name === name || s.name + "@" + s.version === name,
      );
      requireCondition(
        candidates.length === 1,
        "conflict",
        "Skill requires one explicit version",
      );
      return structuredClone(candidates[0]!);
    });
    return [
      ...new Map(resolved.map((s) => [s.name + "@" + s.version, s])).values(),
    ];
  }
}
