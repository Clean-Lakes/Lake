import { chmod, lstat, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { privateDirectory } from "./storage/database.js";

const VALID_ID = /^[a-z0-9_-]{1,128}$/u;
const KINDS = new Set(["ssh", "kubeconfig", "database", "model", "mcp"]);
export class FileVault {
  constructor(private readonly root: string) {}
  private path(kind: string, id: string): string {
    if (!KINDS.has(kind) || !VALID_ID.test(id)) throw new Error("无效的凭据引用");
    return join(this.root, "secrets", kind, id);
  }
  private reference(ref: string): [string, string] {
    const match = /^file:(ssh|kubeconfig|database)\/([a-f0-9]{32})$/u.exec(ref);
    if (!match) throw new Error("凭据仍在旧存储或引用无效；请先运行 lake secrets migrate");
    return [match[1], match[2]];
  }
  async import(kind: string, value: Uint8Array): Promise<string> {
    const id = randomBytes(16).toString("hex");
    await this.put(kind, id, value); return `file:${kind}/${id}`;
  }
  async put(kind: string, id: string, value: Uint8Array): Promise<void> {
    const limit = kind === "kubeconfig" ? 4 * 1024 * 1024 : kind === "ssh" ? 1024 * 1024 : 65536;
    if (!value.length || value.length > limit) throw new Error("凭据为空或过长");
    const path = this.path(kind, id);
    for (const directory of [this.root, join(this.root, "secrets"), dirname(path)]) await privateDirectory(directory);
    const temporary = join(dirname(path), `.lake-secret-${randomBytes(16).toString("hex")}`);
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(value); await file.sync(); await file.close();
      await rename(temporary, path); await chmod(path, 0o600);
    } catch (error) { await file.close().catch(() => {}); throw error; }
    finally { await rm(temporary, { force: true }); }
  }
  async privatePath(kind: string, id: string): Promise<string> {
    const path = this.path(kind, id);
    for (const directory of [this.root, join(this.root, "secrets"), dirname(path)]) {
      const info = await lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077)) throw new Error("凭据目录权限不安全");
    }
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077)) throw new Error("凭据文件权限不安全");
    return path;
  }
  async load(kind: string, id: string): Promise<Buffer> { return readFile(await this.privatePath(kind, id)); }
  async loadReference(ref: string): Promise<Buffer> { const [kind, id] = this.reference(ref); return this.load(kind, id); }
  async referencePath(ref: string): Promise<string> { const [kind, id] = this.reference(ref); return this.privatePath(kind, id); }
  async has(kind: string, id: string): Promise<boolean> {
    try { await this.privatePath(kind, id); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
  }
  async delete(kind: string, id: string): Promise<void> { await rm(this.path(kind, id), { force: true }); }
  async deleteReference(ref: string): Promise<void> { const [kind, id] = this.reference(ref); await this.delete(kind, id); }
}
