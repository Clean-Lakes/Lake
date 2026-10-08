import { createHash } from "node:crypto";
import type { SpecialistProfile } from "../domain/entities.js";
import { ProfileSchema } from "../domain/config.js";
export const generalProfile: SpecialistProfile = {
  id: "sre-general",
  name: "SRE 专员",
  instructions:
    "Investigate and operate within the assigned work order; verify outcomes with evidence.",
  extraSkills: [],
  defaultPowers: [],
  maxTurns: 30,
};
export function freezeProfile(input: SpecialistProfile): {
  profile: SpecialistProfile;
  digest: string;
} {
  const { modelOverride, ...rest } = ProfileSchema.parse(input);
  const profile = { ...rest, ...(modelOverride ? { modelOverride } : {}) };
  return {
    profile,
    digest: createHash("sha256").update(JSON.stringify(profile)).digest("hex"),
  };
}
