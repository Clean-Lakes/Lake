import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { readFile, readdir } from "node:fs/promises";
import { atomicFile } from "../config/files.js";
import { dirname, join, posix } from "node:path";
import type { SSHBackend, RemoteConnection, StdioStream } from "@zcode/server/remote";
import type { JsonValue } from "../../domain/json.js";
import type { DataPort } from "../../app/ports.js";
import type { LakeEvent } from "../../domain/protocol.js";
import { object, text, type Params } from "../../domain/validation.js";
import { sensitivePath, workspaceRelative, shellQuote as q } from "../../domain/workspace.js";
import type { FileVault } from "../vault.js";

export interface NativeRemoteSession {
  workspace: string;
  signature: string;
  open(
    directory: string,
    cli: string,
    gatewayURL: string,
    owner: string,
  ): Promise<{ stream: StdioStream; url: string; directory: string; dispose(): void }>;
}
interface Entry {
  snapshot: string;
  backend: SSHBackend;
  connection: RemoteConnection;
  workspace: Params;
}

/** Lake resolves an authorized resource; ZCode owns SSH, deployment, remote services and PTYs. */
export class NativeRemoteHost {
  private readonly entries = new Map<string, Promise<Entry>>();
  private readonly terminals = new Map<
    string,
    { id: string; conversation: string; dispose(): void }
  >();
  constructor(
    private readonly data: DataPort,
    private readonly vault: FileVault,
    private readonly emit: (event: LakeEvent) => void,
  ) {}
  private async scope(
    id: string,
  ): Promise<{ workspace: Params; resource: Params; ref: string; snapshot: string }> {
    const workspace = object(await this.data.request("code.remote.get", { id })),
      resource = object(await this.data.request("res.get", { resource: workspace.resource_id }));
    if (
      workspace.authorized !== true ||
      resource.execute_authz !== true ||
      resource.kind !== "host" ||
      resource.lake_id !== workspace.lake_id
    )
      throw new Error("远程工作区或关联主机尚未授权");
    const ref = text(
      object(await this.data.request("res.credential", { resource: resource.id })),
      "ref",
    );
    return { workspace, resource, ref, snapshot: JSON.stringify([workspace, resource, ref]) };
  }
  private async get(id: string, signal: AbortSignal): Promise<Entry> {
    const scope = await this.scope(id),
      previous = this.entries.get(id);
    if (previous) {
      const entry = await previous;
      if (entry.snapshot === scope.snapshot) return entry;
      await entry.connection.disposeAndWait();
      entry.backend.dispose();
      this.entries.delete(id);
    }
    const pending = (async () => {
      const { SSHBackend, connectRemote } = await import("@zcode/server/remote");
      const ssh = object(scope.resource.ssh),
        host = text(ssh, "host"),
        port = Number(ssh.port ?? 22),
        address = port === 22 ? host : `[${host}]:${port}`;
      const known = await promisify(execFile)(
        "ssh-keygen",
        ["-F", address, "-f", join(homedir(), ".ssh", "known_hosts")],
        { maxBuffer: 1024 * 1024 },
      ).catch(() => ({ stdout: "" }));
      const keys = known.stdout
        .split("\n")
        .filter((line) => line && !line.startsWith("#") && !line.startsWith("@"))
        .map((line) => Buffer.from(line.trim().split(/\s+/u)[2] ?? "", "base64"))
        .filter((key) => key.length);
      if (!keys.length)
        throw new Error("known_hosts 中没有此主机的可信记录；先使用 SSH 确认主机身份");
      const key = await this.vault.loadReference(scope.ref);
      let backend: SSHBackend | undefined;
      try {
        backend = new SSHBackend({
          host,
          port,
          username: text(ssh, "username"),
          privateKey: key,
          agent: "",
          hostVerifier: (actual: Buffer | string) =>
            keys.some((expected) =>
              expected.equals(Buffer.isBuffer(actual) ? actual : Buffer.from(actual, "hex")),
            ),
        });
        const connection = await connectRemote(backend, {
          signal,
          localServerBundlePath: join(dirname(process.execPath), "remote", "zcode-server.cjs"),
          onDidRemoteClose: () => {
            this.entries.delete(id);
            this.terminals.delete(id);
          },
        });
        if ((await this.scope(id)).snapshot !== scope.snapshot) {
          await connection.disposeAndWait();
          throw new Error("远程绑定在连接期间已变化");
        }
        return { snapshot: scope.snapshot, backend, connection, workspace: scope.workspace };
      } catch (error) {
        backend?.dispose();
        throw error;
      } finally {
        key.fill(0);
      }
    })();
    this.entries.set(id, pending);
    try {
      return await pending;
    } catch (error) {
      this.entries.delete(id);
      throw error;
    }
  }
  async request(method: string, p: Params, signal: AbortSignal): Promise<JsonValue> {
    if (method === "remote.workbench.status") {
      await this.scope(text(p, "id"));
      const terminal = this.terminals.get(text(p, "id"));
      return terminal
        ? {
            id: terminal.id,
            native: true,
            target: text(
              object(await this.data.request("code.remote.get", { id: p.id })),
              "remote_root",
            ),
            running: false,
          }
        : null;
    }
    if (method === "remote.workbench.close") {
      const id = text(p, "id"),
        terminal = this.terminals.get(id);
      if (terminal) {
        terminal.dispose();
        this.terminals.delete(id);
        const entry = await this.entries.get(id);
        await entry?.connection.services.terminalService.dispose({ id: terminal.id });
      }
      return null;
    }
    const id = text(p, "id"),
      entry = await this.get(id, signal),
      files = entry.connection.services.fileService,
      root = text(entry.workspace, "remote_root");
    if ((await files.resolvePath({ path: root })) !== root)
      throw new Error("远程根目录的真实路径与登记值不同");
    if (method === "remote.workbench.files") {
      const paths = await files.searchWorkspaceFiles({
        rootPath: root,
        query: text(p, "filter"),
        limit: 500,
      });
      const safe = [];
      for (const item of paths)
        if (item.type === "file" && !sensitivePath(item.relativePath)) {
          try {
            await this.path(entry, item.relativePath);
            safe.push(item.relativePath);
          } catch {}
        }
      return safe;
    }
    if (method === "remote.workbench.run") {
      let terminal = this.terminals.get(id);
      const service = entry.connection.services.terminalService,
        conversation = text(p, "conversation_id");
      if (terminal && terminal.conversation !== conversation)
        throw new Error("原生远程终端属于另一个任务，请先关闭该终端");
      if (!terminal) {
        const created = await service.create({ cwd: root, cols: 120, rows: 30 });
        const data = service.onDynamicData(created.id)((chunk) =>
          this.emit({
            type: "terminal_data",
            workspace_id: id,
            conversation_id: conversation,
            terminal_id: created.id,
            text: chunk,
          }),
        );
        const exit = service.onDynamicExit(created.id)((code) => {
          this.terminals.get(id)?.dispose();
          this.terminals.delete(id);
          this.emit({
            type: "terminal_exit",
            workspace_id: id,
            conversation_id: conversation,
            terminal_id: created.id,
            exit_code: code,
          });
        });
        terminal = {
          id: created.id,
          conversation,
          dispose: () => {
            data.dispose();
            exit.dispose();
          },
        };
        this.terminals.set(id, terminal);
      }
      const command = text(p, "command");
      await service.write({
        id: terminal.id,
        data: text(p, "data", command === "\u0003" ? command : command + "\n"),
      });
      return { id: terminal.id, status: "submitted", native: true, target: root, directory: root };
    }
    const path = await this.path(entry, text(p, "path"));
    if (method === "remote.workbench.read") {
      const result = await files.readTextFile({ path, length: 65536 });
      if (result.isBinary || result.truncated) throw new Error("文件为二进制内容或超过 64 KiB");
      return {
        path: p.path,
        content: result.content,
        sha256: createHash("sha256").update(result.content).digest("hex"),
      };
    }
    if (method === "remote.workbench.write")
      return files.writeTextFile({
        path,
        content: text(p, "content"),
        expectedSha256: text(p, "expected_sha256"),
      });
    throw new Error("未知的原生远程工作台操作");
  }
  private async path(entry: Entry, relative: string): Promise<string> {
    workspaceRelative(relative);
    const root = text(entry.workspace, "remote_root"),
      path = posix.join(root, relative),
      actual = await entry.connection.services.fileService.resolvePath({ path });
    if (actual !== path || !actual.startsWith(root + "/"))
      throw new Error("远程文件超出工作区或为符号链接");
    return path;
  }
  async agent(id: string, signal: AbortSignal): Promise<NativeRemoteSession> {
    const entry = await this.get(id, signal),
      workspace = text(entry.workspace, "remote_root");
    return {
      workspace,
      signature: entry.snapshot,
      open: async (directory, cli, url, owner) => {
        if ((await this.scope(id)).snapshot !== entry.snapshot) throw new Error("远程授权已变化");
        const forward = await entry.backend.forwardLocal(Number(new URL(url).port)),
          remoteURL = `http://127.0.0.1:${forward.port}`,
          hash = createHash("sha256").update(owner).digest("hex"),
          remote = `~/.lake/zcode-runtime/${hash}`;
        // Only connection/provider presentation files are transferred; native deployment owns the runtime.
        const init = await entry.backend.exec(
          `umask 077; mkdir -p "$HOME/.lake/zcode-runtime/${hash}"`,
        );
        await new Promise<void>((resolve, reject) => {
          init.stdout.resume();
          init.stderr.resume();
          init.onClose((code) =>
            code === 0 ? resolve() : reject(new Error("无法准备原生会话目录")),
          );
        });
        try {
          for (const file of ["builtin.json", "personal.json"]) {
            const path = join(directory, file);
            await atomicFile(path, (await readFile(path, "utf8")).replaceAll(url, remoteURL));
            await entry.backend.upload(path, `${remote}/${file}`);
          }
          const agents = join(dirname(directory), "storage", "agents");
          const mkdir = await entry.backend.exec(
            'umask 077; mkdir -p "$HOME/.lake/zcode-runtime/storage/agents"; rm -f "$HOME/.lake/zcode-runtime/storage/agents/"lake-*.md',
          );
          await new Promise<void>((resolve, reject) => {
            mkdir.stdout.resume();
            mkdir.stderr.resume();
            mkdir.onClose((code) =>
              code === 0 ? resolve() : reject(new Error("无法准备原生 Agent 配置")),
            );
          });
          for (const file of await readdir(agents).catch(() => []))
            if (/^lake-[a-zA-Z0-9_-]{1,64}\.md$/.test(file))
              await entry.backend.upload(
                join(agents, file),
                `~/.lake/zcode-runtime/storage/agents/${file}`,
              );
          // ZCode deployment owns the remote CLI and its native dependencies.
          void cli;
          const base = `$HOME/.lake/zcode-runtime/${hash}`;
          const command = `cd -- ${q(workspace)} && NODE_ENV=production ZCODE_STORAGE_DIR="$HOME/.lake/zcode-runtime/storage" ZCODE_SESSION_DB_PATH="${base}/sessions.sqlite" ZCODE_BUILTIN_PROVIDER_CONFIG_FILE="${base}/builtin.json" ZCODE_PERSONAL_PROVIDER_CONFIG_FILE="${base}/personal.json" "$HOME/.zcode/server/node" "$HOME/.zcode/server/agents/glm/zcode.cjs" app-server --cwd ${q(workspace)} --surface desktop`;
          return {
            stream: await entry.backend.exec(command),
            url: remoteURL,
            directory: remote,
            dispose: () => forward.dispose(),
          };
        } catch (error) {
          forward.dispose();
          throw error;
        }
      },
    };
  }
  async close() {
    await Promise.allSettled(
      [...this.entries.values()].map(async (pending) => {
        const entry = await pending;
        await entry.connection.disposeAndWait();
        entry.backend.dispose();
      }),
    );
    this.entries.clear();
    this.terminals.clear();
  }
}
