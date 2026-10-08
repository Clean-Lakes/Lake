import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { privateDirectory } from "../storage/credentials.js";
export async function prepareHome(
  home = process.env.LAKE_HOME ?? join(homedir(), ".lake"),
): Promise<{
  home: string;
  agent: string;
  database: string;
}> {
  home = resolve(home);
  await privateDirectory(home);
  const agent = join(home, "agent");
  await privateDirectory(agent);
  for (const folder of ["runtime", "artifacts", "checkpoints"])
    await privateDirectory(join(agent, folder));
  return { home, agent, database: join(agent, "agent.db") };
}
