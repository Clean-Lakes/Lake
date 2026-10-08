import { open, constants } from "node:fs/promises";
import { flock } from "fs-ext";
import { LakeError, requireCondition } from "../domain/errors.js";
export async function acquireDaemonLock(path: string): Promise<{
  release(): Promise<void>;
}> {
  const fd = await open(
    path,
    constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
    0o600,
  );
  const st = await fd.stat();
  requireCondition(
    st.isFile() && st.uid === process.getuid?.() && (st.mode & 0o077) === 0,
    "scope_denied",
  );
  try {
    await new Promise<void>((resolve, reject) =>
      flock(fd.fd, "exnb", (error) => (error ? reject(error) : resolve())),
    );
  } catch {
    await fd.close();
    throw new LakeError("daemon_already_running");
  }
  return {
    async release() {
      await new Promise<void>((resolve, reject) =>
        flock(fd.fd, "un", (error) => (error ? reject(error) : resolve())),
      );
      await fd.close();
    },
  };
}
