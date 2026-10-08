import { createLakeApplication } from "../../src/app/application.js";
const [home, actionId, point] = process.argv.slice(2);
if (!home || !actionId || !point)
  throw new Error("Fault fixture arguments required");
const app = await createLakeApplication({
  home,
  background: false,
  fault: async (current) => {
    if (current === point) process.kill(process.pid, "SIGKILL");
  },
});
await app.runner.run(actionId, new AbortController().signal);
await app.stop();
process.exitCode = 9;
