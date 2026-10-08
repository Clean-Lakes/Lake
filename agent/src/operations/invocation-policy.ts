import type { Session, Resource, Effect } from "../domain/entities.js";
import { requireCondition } from "../domain/errors.js";
export function checkInvocation(
  session: Session,
  resource: Resource,
  effect: Effect,
): void {
  const policy = session.invocation;
  if (!policy || effect === "read") return;
  requireCondition(
    policy.sandboxMode !== "read-only",
    "scope_denied",
    "Read-only session rejects changes and interactive input",
  );
  if (policy.sandboxMode === "workspace-write")
    requireCondition(
      resource.kind === "local" &&
        (policy.workspaceRoots ?? []).some(
          (root) =>
            resource.endpoint === root ||
            resource.endpoint.startsWith(root + "/"),
        ),
      "scope_denied",
      "Workspace-write does not allow this target",
    );
}
export function autoApprove(session: Session, resources: Resource[]): boolean {
  const p = session.invocation;
  return Boolean(
    p &&
      (p.bypassApprovals ||
        (p.approvalPolicy === "never" &&
          p.sandboxMode === "workspace-write" &&
          resources.every(
            (r) =>
              r.kind === "local" &&
              (p.workspaceRoots ?? []).some(
                (root) =>
                  r.endpoint === root || r.endpoint.startsWith(root + "/"),
              ),
          ))),
  );
}
