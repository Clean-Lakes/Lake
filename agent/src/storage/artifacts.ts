import { open, rename, readFile, lstat, readdir, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import type { StorePort } from "../domain/ports.js";
import { requireCondition } from "../domain/errors.js";
import { privateDirectory } from "./credentials.js";
import { Redactor } from "./redaction.js";
export class ArtifactStore {
  constructor(
    readonly root: string,
    private readonly store: StorePort,
    private readonly redactor: Redactor,
    private readonly maxBytes = 10485760,
  ) {}
  async cleanUnreferenced(): Promise<void> {
    await privateDirectory(this.root);
    const valid = new Set(
      (await this.store.list<{ id: string }>("artifacts")).map((a) => a.id),
    );
    for (const entry of await readdir(this.root, { withFileTypes: true })) {
      if (!/^[0-9a-f-]{36}(\.tmp)?$/.test(entry.name) || valid.has(entry.name))
        continue;
      await rm(join(this.root, entry.name), { force: true });
    }
  }
  async put(text: string, sessionId?: string): Promise<string> {
    text = this.redactor.text(text);
    requireCondition(Buffer.byteLength(text) <= this.maxBytes, "output_limit");
    await privateDirectory(this.root);
    const id = randomUUID();
    const hash = createHash("sha256").update(text).digest("hex");
    const tmp = join(this.root, id + ".tmp");
    const fd = await open(
      tmp,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await fd.writeFile(text);
      await fd.sync();
    } finally {
      await fd.close();
    }
    await rename(tmp, join(this.root, id));
    await this.store.transact([
      {
        op: "put",
        table: "artifacts",
        value: {
          id,
          revision: 1,
          hash,
          size: Buffer.byteLength(text),
          ...(sessionId ? { sessionId } : {}),
        },
        expectedRevision: 0,
      },
    ]);
    return id;
  }
  async read(id: string): Promise<string> {
    requireCondition(/^[0-9a-f-]{36}$/.test(id), "invalid_input");
    const meta = await this.store.get<{
      hash: string;
    }>("artifacts", id);
    requireCondition(meta, "not_found");
    const path = join(this.root, id);
    const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const st = await fd.stat();
      requireCondition(
        st.isFile() && (st.mode & 0o077) === 0 && st.size <= this.maxBytes,
        "scope_denied",
      );
      const text = await fd.readFile("utf8");
      requireCondition(
        createHash("sha256").update(text).digest("hex") === meta.hash,
        "precondition_failed",
      );
      return text;
    } finally {
      await fd.close();
    }
  }
}
