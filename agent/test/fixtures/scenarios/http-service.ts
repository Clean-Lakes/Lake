import type { ToolCall } from "../../../src/domain/ports.js";
export function makeIncidentScenario(resourceId: string, stepIds: string[]) {
  const stages = new Map<string, number>(),
    workers: string[] = [];
  const call = (name: string, args: unknown) => ({
    calls: [
      {
        id: "scene-" + crypto.randomUUID(),
        name,
        arguments: JSON.stringify(args),
      },
    ],
  });
  return (body: any) => {
    if (!body.tools?.length)
      return {
        text: JSON.stringify({
          facts: [],
          unresolvedActions: [],
          evidenceIds: [],
          userConstraints: [],
          decisions: [],
        }),
      };
    const context = JSON.parse(body.messages[1].content),
      shared = context.shared,
      actor = shared.workOrder?.workerId ?? shared.session.id,
      stage = stages.get(actor) ?? 0;
    const coordinator = body.tools.some(
      (t: any) => t.function.name === "specialist_spawn",
    );
    if (coordinator) {
      const toolMessages = body.messages
        .filter((m: any) => m.role === "tool")
        .map((m: any) => JSON.parse(m.content));
      for (const result of toolMessages)
        if (
          result.data?.id &&
          result.data?.profileId &&
          !workers.includes(result.data.id)
        )
          workers.push(result.data.id);
      stages.set(actor, stage + 1);
      if (stage === 0)
        return call("task_plan", {
          steps: stepIds.map((id, i) => ({
            id,
            label: "HTTP investigation " + (i + 1),
            dependencies: [],
          })),
        });
      if (stage === 1)
        return call("specialist_spawn", {
          objective: "Primary HTTP diagnostic",
          resourceIds: [resourceId],
          stepIds: [stepIds[0]],
        });
      if (stage === 2)
        return call("specialist_await", { specialistId: workers[0] });
      if (stage === 3)
        return call("specialist_spawn", {
          objective: "Second HTTP diagnostic",
          resourceIds: [resourceId],
          stepIds: [stepIds[1]],
        });
      if (stage === 4)
        return call("specialist_spawn", {
          objective: "Independent HTTP verification",
          resourceIds: [resourceId],
          stepIds: [stepIds[2]],
        });
      if (stage === 5)
        return call("specialist_await", { specialistId: workers[1] });
      if (stage === 6)
        return call("specialist_await", { specialistId: workers[2] });
      return call("task_deliver", {});
    }
    const step = shared.steps.find(
      (s: any) => s.id === shared.workOrder.stepIds[0],
    );
    stages.set(actor, stage + 1);
    if (stage === 0)
      return call("task_claim_step", {
        stepId: step.id,
        expectedRevision: step.revision,
      });
    if (stage === 1) return call("power_enable", { powerId: "http-health" });
    if (stage === 2) {
      const terminal = shared.terminals.find(
        (t: any) => t.resourceId === resourceId,
      );
      return terminal
        ? call("terminal_attach", { terminalId: terminal.id })
        : call("terminal_open", { resourceId, powerId: "http-health" });
    }
    const terminal = shared.terminals.find(
      (t: any) => t.resourceId === resourceId,
    );
    if (stage === 3)
      return call("terminal_execute", {
        terminalId: terminal.id,
        capability: "http-health.probe",
        parameters: {},
      });
    if (stage === 4) {
      const observation = shared.observations
        .filter((o: any) => o.resourceId === resourceId && o.trusted)
        .at(-1);
      return call("task_report", {
        stepId: step.id,
        evidenceIds: [observation.id],
        complete: true,
      });
    }
    return call("specialist_deliver", {});
  };
}
export function makeConfigChangeScenario(descriptor: {
  sshId: string;
  httpId: string;
  serviceId: string;
  path: string;
  unit: string;
  stepIds: string[];
  mode: "config" | "recovery";
}) {
  const stages = new Map<string, number>();
  let workerId = "";
  const call = (name: string, args: unknown) => ({
    calls: [
      {
        id: "scene-" + crypto.randomUUID(),
        name,
        arguments: JSON.stringify(args),
      },
    ],
  });
  return (body: any) => {
    if (!body.tools?.length)
      return {
        text: JSON.stringify({
          facts: [],
          unresolvedActions: [],
          evidenceIds: [],
          userConstraints: [],
          decisions: [],
        }),
      };
    const context = JSON.parse(body.messages[1].content),
      shared = context.shared,
      actor = shared.workOrder?.workerId ?? shared.session.id,
      stage = stages.get(actor) ?? 0;
    const results = body.messages
      .filter((m: any) => m.role === "tool")
      .map((m: any) => JSON.parse(m.content));
    if (body.tools.some((t: any) => t.function.name === "specialist_spawn")) {
      for (const result of results)
        if (result.data?.profileId) workerId = result.data.id;
      stages.set(actor, stage + 1);
      if (stage === 0)
        return call("task_plan", {
          steps: descriptor.stepIds.map((id, i) => ({
            id,
            label: ["诊断", "受控修复", "业务验证"][i],
            dependencies: i ? [descriptor.stepIds[i - 1]] : [],
          })),
        });
      if (stage === 1)
        return call("specialist_spawn", {
          objective:
            "Diagnose, perform the frozen change, then verify the fixture service",
          resourceIds: [descriptor.sshId, descriptor.httpId],
          stepIds: descriptor.stepIds,
        });
      if (stage === 2)
        return call("specialist_await", { specialistId: workerId });
      return call("task_deliver", {});
    }
    const terminal = shared.terminals.find(
        (t: any) => t.resourceId === descriptor.sshId,
      ),
      step = (n: number) =>
        shared.steps.find((s: any) => s.id === descriptor.stepIds[n]);
    const facts = shared.observations.filter((o: any) => o.trusted),
      lastSsh = () =>
        facts.filter((o: any) => o.resourceId === descriptor.sshId).at(-1);
    const sshResults = results
        .map((r: any) => r.data?.execution)
        .filter(Boolean),
      read = sshResults.find((r: any) => typeof r.hash === "string"),
      proposal = sshResults.find((r: any) => r.artifactId);
    const actions = shared.actions.filter((a: any) => a.actor === actor),
      changed = actions.find(
        (a: any) =>
          a.capability === "ssh.replace_config" ||
          a.capability === "ssh.service_action",
      );
    const mutation = () =>
      descriptor.mode === "config"
        ? call("terminal_execute", {
            terminalId: terminal.id,
            capability: "ssh.replace_config",
            parameters: {
              path: descriptor.path,
              expectedHash: read.hash,
              artifactId: proposal.artifactId,
              rollback: true,
            },
          })
        : call("terminal_execute", {
            terminalId: terminal.id,
            capability: "ssh.service_action",
            parameters: { unit: descriptor.unit, action: "start" },
          });
    const operations = [
      () =>
        call("task_claim_step", {
          stepId: step(0).id,
          expectedRevision: step(0).revision,
        }),
      () => call("power_enable", { powerId: "ssh" }),
      () =>
        call("terminal_open", { resourceId: descriptor.sshId, powerId: "ssh" }),
      () =>
        call("terminal_execute", {
          terminalId: terminal.id,
          capability:
            descriptor.mode === "config"
              ? "ssh.read_config"
              : "ssh.service_status",
          parameters:
            descriptor.mode === "config"
              ? { path: descriptor.path }
              : { unit: descriptor.unit },
        }),
      () =>
        call("task_report", {
          stepId: step(0).id,
          evidenceIds: [lastSsh().id],
          complete: true,
        }),
      () =>
        call("task_claim_step", {
          stepId: step(1).id,
          expectedRevision: step(1).revision,
        }),
      ...(descriptor.mode === "config"
        ? [
            () =>
              call("terminal_execute", {
                terminalId: terminal.id,
                capability: "ssh.propose_config",
                parameters: {
                  path: descriptor.path,
                  expectedHash: read.hash,
                  content: JSON.stringify({
                    message: "fixture-ok agent-change",
                    healthy: true,
                  }),
                },
              }),
          ]
        : []),
      mutation,
      () =>
        call("task_report", {
          stepId: step(1).id,
          evidenceIds: shared.evidence
            .filter((e: any) => e.result && e.actionId === changed.id)
            .map((e: any) => e.id),
          complete: true,
        }),
      () =>
        call("task_claim_step", {
          stepId: step(2).id,
          expectedRevision: step(2).revision,
        }),
      () => call("power_enable", { powerId: "http-health" }),
      () =>
        call("http_health_health_window", {
          resourceId: descriptor.httpId,
          serviceId: descriptor.serviceId,
        }),
      () =>
        call("task_report", {
          stepId: step(2).id,
          evidenceIds: [
            facts.filter((o: any) => o.resourceId === descriptor.httpId).at(-1)
              .id,
          ],
          complete: true,
        }),
      () => call("specialist_deliver", {}),
    ];
    stages.set(actor, stage + 1);
    return operations[Math.min(stage, operations.length - 1)]!();
  };
}
