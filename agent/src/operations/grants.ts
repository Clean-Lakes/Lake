import { randomUUID } from "node:crypto";
import type { StorePort, DbCommand } from "../domain/ports.js";
import type {
  Resource,
  Grant,
  Effect,
  Session,
  Observation,
  Evidence,
  Action,
} from "../domain/entities.js";
import { requireCondition } from "../domain/errors.js";
import { changeCommands } from "../domain/events.js";
export class GrantService {
  constructor(private readonly store: StorePort) {}
  async create(
    resourceId: string,
    effects: Effect[],
    principal: string,
    id: string = randomUUID(),
  ): Promise<Grant> {
    const resource = await this.store.get<Resource>("resources", resourceId);
    requireCondition(
      resource &&
        effects.length > 0 &&
        effects.every((e) => ["read", "change", "interactive"].includes(e)),
      "invalid_input",
    );
    const old = await this.store.get<Grant>("resource_grants", id);
    if (old) return old;
    const grant: Grant = {
      id,
      revision: 1,
      lakeId: resource.lakeId,
      environmentId: resource.environmentId,
      resourceId,
      resourceIdentity: resource.identity,
      resourceRevision: resource.revision,
      effects,
      principal,
    };
    await this.store.transact(
      changeCommands(
        "resource_grants",
        grant,
        "grant.created",
        principal,
        new Date().toISOString(),
      ),
    );
    return grant;
  }
  async resolve(
    resource: Resource,
    effect: Effect,
    principal: string,
  ): Promise<Grant> {
    const grants = await this.store.list<Grant>("resource_grants");
    const grant = grants.find(
      (g) =>
        g.resourceId === resource.id &&
        g.resourceIdentity === resource.identity &&
        g.resourceRevision === resource.revision &&
        g.lakeId === resource.lakeId &&
        g.environmentId === resource.environmentId &&
        g.principal === principal &&
        !g.revokedAt &&
        g.effects.includes(effect),
    );
    requireCondition(grant, "scope_denied", "No current resource grant");
    return grant;
  }
  async revoke(id: string, principal: string): Promise<void> {
    const g = await this.store.get<Grant>("resource_grants", id);
    requireCondition(g?.principal === principal, "scope_denied");
    if (g.revokedAt) return;
    const time = new Date().toISOString();
    const commands = changeCommands(
      "resource_grants",
      { ...g, revision: g.revision + 1, revokedAt: time },
      "grant.revoked",
      principal,
      time,
    );
    for (const s of await this.store.list<Session>("sessions"))
      if (
        s.lakeId === g.lakeId &&
        s.environmentId === g.environmentId &&
        !["succeeded", "failed", "cancelled"].includes(s.status)
      )
        commands.push(
          ...changeCommands(
            "sessions",
            { ...s, revision: s.revision + 1 },
            "session.context_changed",
            principal,
            time,
          ),
        );
    for (const table of ["observations", "evidence"])
      for (const row of await this.store.list<Observation | Evidence>(table))
        if (row.resourceId === g.resourceId)
          commands.push({
            op: "put",
            table,
            value: { ...row, revision: row.revision + 1, invalidatedAt: time },
            expectedRevision: row.revision,
          });
    for (const a of await this.store.list<Action>("actions"))
      if (
        a.targets.some((r) => r.id === g.resourceId) &&
        ["queued", "authorized", "waiting_approval"].includes(a.status)
      )
        commands.push(
          ...changeCommands(
            "actions",
            { ...a, revision: a.revision + 1, status: "blocked" },
            "action.finished",
            principal,
            time,
          ),
          { op: "unlock", owner: a.id },
        );
    await this.store.transact(commands);
  }
}
