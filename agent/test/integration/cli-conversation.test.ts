import test from "node:test";
import assert from "node:assert/strict";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { testApplication } from "../fixtures/application.js";
import { startModelFixture } from "../fixtures/model-server.js";
import { createHttpServer } from "../../src/surfaces/http-server.js";
import { DaemonClient } from "../../src/surfaces/daemon-client.js";
import { finalResponse } from "../../src/surfaces/cli-exec.js";
import { resolveWorkspaces } from "../../src/app/workspaces.js";
import { startPty } from "../fixtures/pty.js";

async function setup(t: any, reply?: Parameters<typeof startModelFixture>[0]) {
  const model = reply ? await startModelFixture(reply) : undefined;
  const h = await testApplication(model?.baseUrl),
    http = await createHttpServer(h.app),
    workspace = h.home + "-workspace";
  await mkdir(workspace);
  await writeFile(
    join(h.home, "agent/runtime/daemon.json"),
    JSON.stringify({
      origin: http.origin,
      token: http.auth.token,
      nonce: http.auth.nonce,
      pid: process.pid,
    }),
    { mode: 0o600 },
  );
  t.after(async () => {
    await http.close();
    await h.close();
    await model?.close();
    await rm(workspace, { recursive: true, force: true });
  });
  return {
    ...h,
    http,
    workspace,
    model,
    client: new DaemonClient(
      {
        origin: http.origin,
        token: http.auth.token,
        nonce: http.auth.nonce,
        pid: process.pid,
      },
      h.home,
    ),
  };
}

test("an older report without streamed text still yields a readable verified answer", async (t) => {
  const h = await setup(t);
  const result = await h.app.inspectLocalStatus(
    h.workspace,
    crypto.randomUUID(),
  );
  const text = await finalResponse(h.client, result.sessionId);
  assert.match(text, /本机 .*\nCPU .*\n内存 /);
  assert.match(text, /磁盘 已用/);
  assert.match(text, /验收：已验证/);
  assert(!text.startsWith("{"));
});

test("a persisted final summary wins over earlier progress and needs no extra model call", async (t) => {
  let resourceId = "";
  const h = await setup(t, (_, n) =>
    n === 1
      ? {
          text: "我正在收集本机数据。",
          calls: [
            {
              id: "read",
              name: "local_files_system_status",
              arguments: JSON.stringify({ resourceId }),
            },
          ],
        }
      : {
          calls: [
            {
              id: "deliver",
              name: "task_deliver",
              arguments: JSON.stringify({
                summary:
                  "最终检查结果：CPU、内存和磁盘已采集。\n内存压力不能只看空闲量。",
              }),
            },
          ],
        },
  );
  const scope = await resolveWorkspaces(h.app, [h.workspace], "read-only");
  resourceId = scope.resourceIds[0]!;
  const s = await h.app.createSession({
    lakeId: scope.lakeId,
    environmentId: scope.environmentId,
    resourceIds: scope.resourceIds,
    objective: "本机状态",
    invocation: { sandboxMode: "read-only" },
  });
  h.app.startRoot(s.id);
  const deadline = Date.now() + 5000;
  let snap: any;
  do {
    await new Promise((r) => setTimeout(r, 20));
    snap = await h.app.data.snapshot(s.id);
  } while (snap.session.status === "active" && Date.now() < deadline);
  assert.equal(snap.session.status, "succeeded");
  const answer = await finalResponse(h.client, s.id, snap);
  assert.match(answer, /^最终检查结果/);
  assert(!answer.includes("正在收集"));
  assert.equal(h.model!.attempts, 2);
});

test(
  "real PTY: blank start, editing, multiline paste, live input, final answer and follow-up",
  { skip: process.platform === "win32" },
  async (t) => {
    const seen: string[] = [];
    const h = await setup(t, (body, n) => {
      const context = JSON.parse(body.messages[1].content);
      const resourceId = context.shared.resources[0].id;
      seen.push(context.shared.task.objective);
      const hasRead = body.messages.some(
        (m: any) =>
          m.role === "tool" && m.content.includes("local-system-status"),
      );
      return hasRead
        ? {
            calls: [
              {
                id: "deliver-" + n,
                name: "task_deliver",
                arguments: JSON.stringify({
                  summary: "最终结果已展示：本机资源采集完成。",
                }),
              },
            ],
          }
        : {
            delayMs: 300,
            calls: [
              {
                id: "read-" + n,
                name: "local_files_system_status",
                arguments: JSON.stringify({ resourceId }),
              },
            ],
          };
    });
    const pty = startPty([
      "--import",
      "tsx",
      "src/surfaces/cli.ts",
      "--home",
      h.home,
      "-C",
      h.workspace,
    ]);
    t.after(() => pty.close());
    await pty.waitFor("输入目标开始");
    assert.equal((await h.app.store.list("sessions")).length, 0);
    pty.write("查看本机X\x7f\x1b[D的\x1b[C状态");
    pty.write("\x1b[200~\nCPU和内存\x1b[201~");
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(
      (await h.app.store.list("sessions")).length,
      0,
      "paste must not submit a task",
    );
    pty.resize(22, 48);
    pty.write("\r");
    await pty.waitFor("等待模型");
    pty.write("下一轮目标");
    await pty.waitFor("最终结果已展示");
    await pty.waitFor("输入下一条继续");
    pty.write("\x1b[A\x1b[B");
    pty.signal("SIGTSTP");
    await new Promise((r) => setTimeout(r, 100));
    pty.signal("SIGCONT");
    await new Promise((r) => setTimeout(r, 100));
    pty.write("\r");
    const deadline = Date.now() + 5000;
    while (
      (await h.app.store.list("sessions")).length < 2 &&
      Date.now() < deadline
    )
      await new Promise((r) => setTimeout(r, 20));
    const sessions = await h.app.store.list<any>("sessions");
    assert.equal(sessions.length, 2);
    assert(sessions.some((s) => s.parentSessionId === sessions[0].id));
    assert(seen.some((s) => s.includes("CPU和内存") && !s.includes("X")));
    const tasks = await h.app.store.list<any>("tasks");
    assert(tasks.some((t) => t.objective === "下一轮目标"));
    assert(
      tasks
        .find((t) => t.objective === "下一轮目标")
        .constraints.some((c: string) => c.includes("最终结果已展示")),
      "tool-only final answers survive the follow-up context",
    );
    await new Promise((r) => setTimeout(r, 1000));
    pty.write("/quit\r");
    await pty.done;
    assert.equal(pty.exitCode, 0);
    assert(
      (pty.output.match(/\x1b\[\?2004h/g)?.length ?? 0) >= 2,
      "suspend/resume restores the composer",
    );
    assert(pty.output.endsWith("\x1b[?2004l"), "exit restores paste mode");
  },
);

test(
  "real PTY cancellation keeps the conversation open and requests durable cancellation",
  { skip: process.platform === "win32" },
  async (t) => {
    const h = await setup(t, () => ({ delayMs: 5000, text: "late" }));
    const pty = startPty([
      "--import",
      "tsx",
      "src/surfaces/cli.ts",
      "--home",
      h.home,
      "-C",
      h.workspace,
      "检查本机",
    ]);
    t.after(() => pty.close());
    await pty.waitFor("等待模型");
    pty.write("\x1b");
    await pty.waitFor("已取消");
    const tasks = await h.app.store.list<any>("tasks");
    assert.equal(tasks[0].status, "cancelled");
    assert(tasks[0].cancelRequestedAt);
    pty.write("/he\t\r");
    await pty.waitFor("显示帮助");
    pty.write("/quit\r");
    await pty.done;
    assert.equal(pty.exitCode, 0);
  },
);

test(
  "real PTY: repeated offline responses are deduplicated and recover without losing the composer",
  { skip: process.platform === "win32" },
  async (t) => {
    const { createServer } = await import("node:http");
    let offline = true,
      attempts = 0;
    const id = crypto.randomUUID();
    const server = createServer((req, res) => {
      attempts++;
      if (offline) {
        res.writeHead(400).end(
          JSON.stringify({
            error: { code: "timeout", message: "测试连接离线" },
          }),
        );
        return;
      }
      res.end(
        JSON.stringify(
          req.url!.includes("activity")
            ? []
            : {
                session: { id, rootTaskId: id },
                tasks: [
                  {
                    id,
                    status: "waiting",
                    waitingReason: "waiting_user_input",
                  },
                ],
                specialist_runs: [],
                actions: [],
                cursor: "0",
              },
        ),
      );
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const address = server.address() as { port: number };
    t.after(async () => {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    });
    const script = `import {interactiveChat} from './src/surfaces/cli-chat.ts'; import {DaemonClient} from './src/surfaces/daemon-client.ts'; await interactiveChat(new DaemonClient({origin:'http://127.0.0.1:${address.port}',token:'fixture',nonce:'fixture',pid:process.pid}),'${id}');`;
    const pty = startPty([
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      script,
    ]);
    t.after(() => pty.close());
    await pty.waitFor("测试连接离线");
    pty.write("恢复后继续");
    await new Promise((r) => setTimeout(r, 4200));
    assert.equal(pty.output.match(/测试连接离线/g)?.length, 1);
    assert(attempts <= 5, `backoff expected; saw ${attempts} attempts`);
    offline = false;
    await pty.waitFor("已重新连接");
    pty.write("\x15/quit\r");
    await pty.done;
    assert.equal(pty.exitCode, 0);
  },
);
