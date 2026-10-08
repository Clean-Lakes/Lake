import { randomUUID } from "node:crypto";
import { startModelFixture } from "./model-server.js";
import { linuxApplication } from "./linux-application.js";
import {
  makeIncidentScenario,
  makeConfigChangeScenario,
} from "./scenarios/http-service.js";
import { createHttpServer } from "../../src/surfaces/http-server.js";
let respond: (body: any, attempt: number) => any = () => ({
  text: "not ready",
});
const model = await startModelFixture((body, attempt) =>
  respond(body, attempt),
);
const h = await linuxApplication(model.baseUrl);
await h.app.grants.create(h.sshId, ["interactive"], "local-user");
const scenes = new Map<string, ReturnType<typeof makeIncidentScenario>>();
respond = (body) => {
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
    sessionId = shared.session.id;
  let scene = scenes.get(sessionId);
  if (!scene) {
    const steps = [randomUUID(), randomUUID(), randomUUID()];
    scene = /协作|输入验证/.test(shared.task?.objective ?? "")
      ? makeIncidentScenario(h.httpId, steps)
      : makeConfigChangeScenario({
          sshId: h.sshId,
          httpId: h.httpId,
          serviceId: h.serviceId,
          path: h.target.configPath,
          unit: h.target.unit,
          stepIds: steps,
          mode: "config",
        });
    scenes.set(sessionId, scene);
  }
  if (
    body.tools.some((t: any) => t.function.name === "specialist_spawn") &&
    /输入验证/.test(shared.task?.objective ?? "") &&
    !context.inbox.length
  )
    return {
      calls: [{ id: randomUUID(), name: "task_deliver", arguments: "{}" }],
    };
  return scene(body);
};
const http = await createHttpServer(h.app, {
  uiRoot: new URL("../../ui/dist", import.meta.url).pathname,
});
(http.auth as any).tickets.set(
  "lake-isolated-fixture-login",
  Date.now() + 60000,
);
console.log(
  JSON.stringify({
    origin: http.origin,
    home: h.home,
    mode: "isolated synthetic-model Linux Web QA",
  }),
);
const stop = async () => {
  await http.close();
  await h.close();
  await model.close();
};
process.once("SIGTERM", () => void stop());
process.once("SIGINT", () => void stop());
