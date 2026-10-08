import type {
  TaskContract,
  WorkOrder,
  SkillSnapshot,
} from "../domain/entities.js";
import { requireCondition } from "../domain/errors.js";
export function createWorkOrder(
  task: TaskContract,
  input: {
    objective: string;
    resourceIds: string[];
    stepIds: string[];
    constraints?: string[];
  },
  skills: SkillSnapshot[],
): WorkOrder {
  requireCondition(
    input.resourceIds.every((id) => task.scope.includes(id)),
    "scope_denied",
  );
  return {
    objective: input.objective,
    resourceIds: [...input.resourceIds],
    stepIds: [...input.stepIds],
    constraints: [...task.constraints, ...(input.constraints ?? [])],
    acceptanceCriteria: structuredClone(task.acceptanceCriteria),
    skillSnapshot: structuredClone(skills),
    inboxCursor: 0,
  };
}
