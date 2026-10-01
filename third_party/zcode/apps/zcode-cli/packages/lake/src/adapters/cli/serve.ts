import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import type { LakeCLIContext } from "../../domain/cli.js";
import type { LakeRuntime } from "../../domain/protocol.js";
import { object, redact, text, type Params } from "../../domain/validation.js";

const CLI_COMMANDS = new Set([
  "ls",
  "current",
  "add",
  "use",
  "model",
  "res",
  "code",
  "conversation",
  "memory",
  "workflow",
  "workflow-v2",
  "permissions",
  "journal",
]);
const METHODS = new Set([
  "settings",
  "conversation.start",
  "conversation.ask",
  "approval.respond",
  "question.answer",
  "execution.cancel",
  "native.subagents",
  "native.extensions",
  "native.plugin.set",
  "native.hook.set",
  "workbench.files",
  "workbench.read",
  "workbench.git",
  "workbench.diff",
  "workbench.terminal.open",
  "workbench.terminal.run",
  "workbench.terminal.status",
  "workbench.terminal.close",
  "workbench.terminal.resize",
  "task.status",
  "task.run",
  "task.close",
  "remote.workbench.files",
  "remote.workbench.read",
  "remote.workbench.write",
  "remote.workbench.run",
]);

/** One process/data owner for the desktop; concurrent replies keep approvals responsive. */
export async function runDesktopServer(
  context: LakeCLIContext,
  runtime: LakeRuntime,
  runCLI: (context: LakeCLIContext) => Promise<number>,
): Promise<void> {
  const send = (value: object) => context.stdout.write(JSON.stringify(value) + "\n");
  const unsubscribe = runtime.subscribe((event) => send({ event })),
    tasks = new Set<Promise<void>>();
  const poll = setInterval(() => {
    void runtime.dispatch({ method: "schedule.poll", params: {} }).catch(() => {});
  }, 30000);
  const lines = createInterface({ input: Readable.from(context.stdin), crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      let request: Params;
      try {
        if (Buffer.byteLength(line) > 16 * 1024 * 1024) throw new Error("桌面请求过长");
        request = object(JSON.parse(line));
      } catch {
        send({ error: "无效的桌面请求" });
        continue;
      }
      const id = text(request, "id");
      const task = (async () => {
        try {
          const method = text(request, "method"),
            params = object(request.params);
          if (!id || id.length > 128) throw new Error("桌面请求 ID 无效");
          let result;
          if (method === "cli") {
            const argv = params.argv;
            if (
              !Array.isArray(argv) ||
              argv.length > 128 ||
              argv.some((value) => typeof value !== "string" || value.length > 4096) ||
              !CLI_COMMANDS.has(String(argv[0]))
            )
              throw new Error("桌面命令不在公开接口中");
            const input = Buffer.from(text(params, "stdin"));
            let output = "",
              error = "";
            try {
              const status = await runCLI({
                argv: argv as string[],
                stdin: (async function* () {
                  yield input;
                })(),
                stdout: {
                  write: (value) => {
                    output += String(value);
                    if (output.length > 8 * 1024 * 1024) throw new Error("桌面响应过长");
                  },
                },
                stderr: {
                  write: (value) => {
                    error += String(value);
                  },
                },
              });
              if (status !== 0) throw new Error(error.trim());
              result = JSON.parse(output);
            } finally {
              input.fill(0);
            }
          } else {
            if (!METHODS.has(method)) throw new Error("桌面方法不在公开接口中");
            if (
              method === "settings" &&
              (params.api_key ||
                Object.keys(object(object(params.server).env)).length ||
                Object.keys(object(object(params.server).headers)).length)
            )
              throw new Error("凭据只能通过本地 Lake CLI 配置");
            result = await runtime.dispatch({ method, params, id });
          }
          send({ id, result });
        } catch (error) {
          send({ id, error: redact(error instanceof Error ? error.message : String(error)) });
        }
      })();
      tasks.add(task);
      void task.finally(() => tasks.delete(task));
    }
  } finally {
    clearInterval(poll);
    await runtime.close();
    await Promise.allSettled(tasks);
    unsubscribe();
    lines.close();
  }
}
