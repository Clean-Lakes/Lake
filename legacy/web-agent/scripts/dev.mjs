import { spawn } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const projectDir = fileURLToPath(new URL("../", import.meta.url));
const env = { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH || ""}` };
const children = ["dev:server", "dev:web"].map((name) =>
  spawn("pnpm", ["run", name], {
    cwd: projectDir,
    stdio: "inherit",
    env: name === "dev:server"
      ? { ...env, LAKE_WEB_DEV_ORIGIN: "http://localhost:5173" }
      : env,
  }),
);

for (const child of children) {
  child.on("exit", (code) => {
    if (code && !process.exitCode) process.exitCode = code;
    for (const other of children) if (other !== child) other.kill("SIGTERM");
  });
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    for (const child of children) child.kill(signal);
  });
}
