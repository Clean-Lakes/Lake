import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  stat,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { testApplication } from "../fixtures/application.js";
import { startModelFixture } from "../fixtures/model-server.js";
import { createHttpServer } from "../../src/surfaces/http-server.js";
async function cli(args: string[], stdin = "") {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "src/surfaces/cli.ts", ...args],
    {
      cwd: new URL("../../", import.meta.url).pathname,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let out = "",
    err = "";
  child.stdout.on("data", (b) => (out += b));
  child.stderr.on("data", (b) => (err += b));
  child.stdin.end(stdin);
  const code = await new Promise<number | null>((r, j) => {
    child.on("error", j);
    child.on("exit", r);
  });
  return { code, out, err };
}
test("help, version and unsupported flags do not create or start a daemon", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "lake-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "absent");
  for (const args of [
    ["--help"],
    ["exec", "--help"],
    ["-V"],
    ["--unsupported"],
    ["cloud"],
  ]) {
    const r = await cli([...args, "--home", home]);
    assert.equal(
      r.code,
      args[0] === "--unsupported" || args[0] === "cloud" ? 1 : 0,
    );
  }
  await assert.rejects(stat(home));
});
test("exec stdin, JSONL, model/profile overrides, file output and exec resume share API state", async (t) => {
  const requests: any[] = [];
  const model = await startModelFixture((body) => {
      requests.push(body);
      return {
        text: "CLI visible response",
        calls: [
          {
            id: "deliver-" + requests.length,
            name: "task_deliver",
            arguments: "{}",
          },
        ],
      };
    }),
    h = await testApplication(model.baseUrl);
  const http = await createHttpServer(h.app),
    root = await mkdtemp(join(tmpdir(), "lake-cli-workspace-"));
  t.after(async () => {
    await http.close();
    await h.close();
    await model.close();
    await rm(root, { recursive: true, force: true });
  });
  (h.app.config as any).cli = {
    profiles: {
      test: { model: "profile-model", model_reasoning_effort: "low" },
    },
  };
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
  await mkdir(join(root, "extra"));
  const output = join(root, "answer.txt");
  const first = await cli(
    [
      "exec",
      "--home",
      h.home,
      "-C",
      root,
      "--add-dir",
      "extra",
      "-p",
      "test",
      "-m",
      "requested-model",
      "-c",
      "limits.sessionMaxModelCalls=9",
      "--json",
      "-o",
      output,
      "Analyze",
    ],
    "piped text",
  );
  assert.equal(first.code, 3, first.err);
  const lines = first.out
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  assert.equal(lines[0].type, "thread.started");
  assert(
    lines.some(
      (e) =>
        e.type === "model.delta" &&
        e.data.text.includes("CLI visible response"),
    ),
  );
  const end = lines.at(-1);
  assert.equal(end.type, "turn.completed");
  assert.equal(end.status, "waiting");
  assert.match(await readFile(output, "utf8"), /CLI visible response/);
  assert.equal((await stat(output)).mode & 0o077, 0);
  assert(!first.out.includes(http.auth.token));
  const snap = (await h.app.data.snapshot(end.sessionId)) as any;
  assert.equal(snap.session.invocation.model, "requested-model");
  assert.equal(snap.session.invocation.reasoningEffort, "low");
  assert.equal(snap.session.budget.maxCalls, 9);
  assert.equal(snap.resources.length, 2);
  assert.match(snap.tasks[0].objective, /<stdin>\npiped text/);
  assert.equal(requests[0].model, "requested-model");
  const resumed = await cli([
    "exec",
    "resume",
    "--last",
    "--home",
    h.home,
    "-C",
    root,
    "--json",
  ]);
  assert.equal(resumed.code, 3, resumed.err);
  assert.equal(
    JSON.parse(resumed.out.split("\n")[0]!).thread_id,
    end.sessionId,
  );
  const forked = await cli([
    "fork",
    end.sessionId,
    "New goal",
    "--home",
    h.home,
    "-C",
    root,
    "--json",
  ]);
  assert.equal(forked.code, 3, forked.err);
  const next = JSON.parse(forked.out.trim().split("\n").at(-1)!);
  assert.notEqual(next.sessionId, end.sessionId);
  const raw = await cli(["--home", h.home, "-C", root, "Inspect"]);
  assert.equal(raw.code, 3, raw.err);
  assert.match(raw.out, /CLI visible response/);
});

test("CLI termination requests durable cancellation while a model request is in flight", async (t) => {
  const model = await startModelFixture(() => ({
      text: "late response",
      delayMs: 500,
    })),
    h = await testApplication(model.baseUrl),
    http = await createHttpServer(h.app),
    root = await mkdtemp(join(tmpdir(), "lake-cli-cancel-"));
  t.after(async () => {
    await http.close();
    await h.close();
    await model.close();
    await rm(root, { recursive: true, force: true });
  });
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
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "src/surfaces/cli.ts",
      "exec",
      "--home",
      h.home,
      "-C",
      root,
      "Inspect",
    ],
    {
      cwd: new URL("../../", import.meta.url).pathname,
      stdio: ["ignore", "ignore", "ignore"],
    },
  );
  const ended = new Promise<number | null>((r) => child.on("exit", r));
  t.after(() => {
    if (child.exitCode === null) child.kill("SIGKILL");
  });
  const deadline = Date.now() + 10000;
  while (model.attempts === 0 && Date.now() < deadline)
    await new Promise((r) => setTimeout(r, 10));
  assert(model.attempts > 0);
  child.kill("SIGTERM");
  assert.equal(await ended, 130);
  const tasks = await h.app.store.list<any>("tasks");
  assert.equal(tasks.length, 1);
  assert(tasks[0].cancelRequestedAt);
  assert.equal(tasks[0].status, "cancelled");
  assert.equal((await h.app.store.list("actions")).length, 0);
});
