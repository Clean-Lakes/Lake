import { mkdir, open, lstat, rename, readFile, chmod } from "node:fs/promises";
import { constants, createReadStream } from "node:fs";
import { resolve, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { LakeError, requireCondition } from "../domain/errors.js";
import type { CredentialPort } from "../domain/ports.js";
import { Redactor } from "./redaction.js";
export async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const st = await lstat(path);
  requireCondition(
    st.isDirectory() && !st.isSymbolicLink() && st.uid === process.getuid?.(),
    "scope_denied",
  );
  await chmod(path, 0o700);
}
export class CredentialStore implements CredentialPort {
  constructor(
    readonly root: string,
    readonly redactor: Redactor,
  ) {}
  private path(ref: string): string {
    requireCondition(
      /^(models|ssh|database|kubeconfig)\/[A-Za-z0-9][A-Za-z0-9_.-]{0,100}$/.test(
        ref,
      ) && !ref.includes(".."),
      "invalid_input",
      "Invalid credential reference",
    );
    return resolve(this.root, ref);
  }
  async import(ref: string, value: Uint8Array): Promise<void> {
    requireCondition(
      value.length > 0 && value.length <= 262144,
      "invalid_input",
    );
    const path = this.path(ref);
    await privateDirectory(this.root);
    await privateDirectory(dirname(path));
    const tmp = path + "." + randomUUID();
    const fd = await open(
      tmp,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await fd.writeFile(value);
      await fd.sync();
    } finally {
      await fd.close();
    }
    await rename(tmp, path);
    this.redactor.register(Buffer.from(value).toString());
  }
  async importFromFd(ref: string, fd: number): Promise<void> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of createReadStream("", { fd, autoClose: false })) {
      const data = Buffer.from(chunk);
      size += data.length;
      requireCondition(
        size <= 262144,
        "output_limit",
        "Credential input is too large",
      );
      chunks.push(data);
    }
    const value = Buffer.concat(chunks);
    try {
      await this.import(ref, value);
    } finally {
      value.fill(0);
      chunks.forEach((c) => c.fill(0));
    }
  }
  async resolve(ref: string): Promise<Uint8Array> {
    const path = this.path(ref);
    for (const dir of [this.root, dirname(path)]) {
      const st = await lstat(dir);
      requireCondition(
        !st.isSymbolicLink() &&
          st.isDirectory() &&
          st.uid === process.getuid?.() &&
          (st.mode & 0o077) === 0,
        "scope_denied",
      );
    }
    const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const st = await fd.stat();
      requireCondition(
        st.isFile() &&
          st.uid === process.getuid?.() &&
          (st.mode & 0o077) === 0 &&
          st.size <= 262144,
        "scope_denied",
      );
      const value = await fd.readFile();
      this.redactor.register(value.toString());
      return value;
    } catch {
      throw new LakeError("scope_denied", "Credential unavailable");
    } finally {
      await fd.close();
    }
  }
}
