import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { startModelFixture } from "../fixtures/model-server.js";
import { linuxApplication } from "../fixtures/linux-application.js";
import { makeConfigChangeScenario } from "../fixtures/scenarios/http-service.js";
for (const mode of ["recovery", "config"] as const)
  test(`Agent-driven Linux service ${mode} crosses human approval and business verification`, async (t) => {
    let respond: (body: any, attempt: number) => any = () => ({
      text: "not ready",
    });
    const model = await startModelFixture((body, attempt) =>
      respond(body, attempt),
    );
    const h = await linuxApplication(model.baseUrl);
    t.after(async () => {
      await h.close();
      await model.close();
    });
    const stepIds = [randomUUID(), randomUUID(), randomUUID()];
    respond = makeConfigChangeScenario({
      sshId: h.sshId,
      httpId: h.httpId,
      serviceId: h.serviceId,
      path: h.target.configPath,
      unit: h.target.unit,
      stepIds,
      mode,
    });
    if (mode === "recovery")
      await h.target.exec(["systemctl", "stop", h.target.unit]);
    const session = await h.createSession();
    h.app.startRoot(session.id);
    const approved = new Set<string>();
    let snapshot: any;
    const end = Date.now() + 30000;
    while (Date.now() < end) {
      snapshot = await h.app.data.snapshot(session.id);
      for (const action of snapshot.actions)
        if (action.status === "waiting_approval" && !approved.has(action.id)) {
          approved.add(action.id);
          await h.app.approve(action.id, action.proposalDigest);
        }
      const task = snapshot.tasks.find((t: any) => t.id === session.rootTaskId);
      if (["succeeded", "qualified", "failed"].includes(task.status)) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    const task = snapshot.tasks.find((t: any) => t.id === session.rootTaskId);
    assert.equal(
      task.status,
      "succeeded",
      JSON.stringify({
        task,
        runs: snapshot.specialist_runs.map((r: any) => r.state),
        actions: snapshot.actions.map((a: any) => ({
          capability: a.capability,
          status: a.status,
          result: a.result,
        })),
      }),
    );
    assert.equal(approved.size, 1);
    assert(snapshot.task_steps.every((s: any) => s.status === "succeeded"));
    assert(
      snapshot.evidence.some(
        (e: any) => e.result && e.source === "http-service-v1",
      ),
    );
    if (mode === "config")
      assert(
        (await h.target.exec(["cat", h.target.configPath])).includes(
          "agent-change",
        ),
      );
  });
