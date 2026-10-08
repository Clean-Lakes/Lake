import type { SpecialistRun } from "../domain/entities.js";
export function buildSpecialistContext(
  run: SpecialistRun,
  shared: unknown,
  inbox: string[],
  loadedSkills: string[],
) {
  return {
    identity: run.profile.instructions,
    baseline:
      "Use the frozen work order and shared facts. Complete only with verification.",
    objective: run.workOrder.objective,
    constraints: run.workOrder.constraints,
    shared,
    inbox,
    skills: run.workOrder.skillSnapshot.map(
      ({ body, source, ...meta }) => meta,
    ),
    loadedSkills,
  };
}
