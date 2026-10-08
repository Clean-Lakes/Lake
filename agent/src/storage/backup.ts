import type { StorePort } from "../domain/ports.js";
import { chmod } from "node:fs/promises";
export async function backupDatabase(
  store: StorePort,
  path: string,
): Promise<void> {
  await store.transact([{ op: "backup", path }]);
  await chmod(path, 0o600);
}
