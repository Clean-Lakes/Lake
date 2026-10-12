import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import type { Action, Catalog, ModelSettings, ModelTestResult, Project, SessionEvent, SessionSnapshot, TerminalHistory, TerminalSession, WorkSession } from "../../shared/contracts.js";

async function port(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  assert(address && typeof address !== "string");
  const number = address.port;
  await new Promise<void>((done) => server.close(() => done()));
  return number;
}

type Setup = {
  base: string; token: string; dataDir: string; process: ChildProcess;
  request: (path: string, init?: RequestInit) => Promise<Response>;
  cleanup: () => void;
};

async function setup(modelUrl?: string, auth: "token" | "generated" | "dev" = "token"): Promise<Setup> {
  const listenPort = await port();
  const dir = mkdtempSync(join(tmpdir(), "lake-web-http-"));
  const token = randomBytes(32).toString("hex");
  const base = `http://127.0.0.1:${listenPort}`;
  const script = resolve(import.meta.dirname, "../src/index.ts");
  const loader = resolve(import.meta.dirname, "../../node_modules/tsx/dist/loader.mjs");
  const child = spawn(process.execPath, ["--import", loader, script], {
    env: {
      ...process.env,
      LAKE_WEB_AI_RUNTIME: "legacy",
      LAKE_HOME: dir,
      LAKE_WEB_TOKEN: auth === "token" ? token : "",
      LAKE_WEB_DEV_ORIGIN: auth === "dev" ? "http://localhost:5173" : "",
      LAKE_WEB_PORT: String(listenPort),
      LAKE_WEB_DATA_DIR: dir,
      LAKE_WEB_MODEL_URL: modelUrl || "",
      LAKE_WEB_MODEL_NAME: modelUrl ? "test-model" : "",
      LAKE_WEB_MODEL_KEY: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  child.stdout?.on("data", (chunk: Buffer) => { logs += chunk.toString(); });
  child.stderr?.on("data", (chunk: Buffer) => { logs += chunk.toString(); });
  child.stdout?.unref();
  child.stderr?.unref();
  const cleanup = () => { child.kill("SIGTERM"); child.unref(); setTimeout(() => rmSync(dir, { recursive: true, force: true }), 300).unref(); };
  const deadline = Date.now() + 10000;
  while (!logs.includes("listening at") && Date.now() < deadline) {
    if (child.exitCode !== null) break;
    await new Promise((done) => setTimeout(done, 20));
  }
  if (!logs.includes("listening at")) {
    cleanup();
    throw Error(`Server failed to start: ${logs.slice(0, 1000)}`);
  }
  return {
    base, token, dataDir: dir, process: child, cleanup,
    request: (path, init = {}) => fetch(`${base}${path}`, {
      ...init, headers: { Authorization: `Bearer ${token}`, ...(init.body ? { "Content-Type": "application/json" } : {}), ...init.headers },
    }),
  };
}

const post = (data: object) => ({ method: "POST", body: JSON.stringify(data) });
async function json<T>(response: Response, status: number): Promise<T> {
  if (response.status !== status) assert.fail(`Expected HTTP ${status}, got ${response.status}: ${await response.text()}`);
  return response.json() as Promise<T>;
}
async function until<T>(fn: () => Promise<T | null>, timeout = 5000): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await fn();
    if (result !== null) return result;
    await new Promise((done) => setTimeout(done, 30));
  }
  throw Error("Timed out waiting for backend result");
}

void test("risk-based HTTP execution skips read-only approval and enforces progressive confirmation", async () => {
  let fixture = "";
  const mock = createServer(async (request, response) => {
    let body = ""; for await (const chunk of request) body += chunk;
    const payload = JSON.parse(body) as { messages: Array<{ content: string }> };
    const context = JSON.parse(payload.messages[1]!.content) as { goal?: string; resources?: Array<{ id: string }>; recordedTerminalHistory?: Array<{ id: string }> };
    let content: string;
    if (isPlanRequest(body)) content = planReply("investigate");
    else if (isTerminalRequest(body)) content = JSON.stringify({ summary: "Check the requested target", steps: [{
      resourceId: context.resources![0]!.id,
      command: context.goal === "write" ? `printf changed > '${fixture}'` : context.goal === "danger" ? `rm -f '${fixture}'` : "ps aux | head -n 3",
      reason: "User request", impact: "Model claims read-only", verification: "Inspect the recorded result",
    }] });
    else content = JSON.stringify({ summary: "Recorded observation", sourceIds: context.recordedTerminalHistory!.map(item => item.id),
      nextCheck: context.goal === "read" ? { command: "uname -a", reason: "Extra check", impact: "Read-only", verification: "Inspect output" } : null });
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
  await new Promise<void>(done => mock.listen(0, "127.0.0.1", done));
  const address = mock.address(); assert(address && typeof address !== "string");
  const app = await setup(`http://127.0.0.1:${address.port}/v1/chat/completions`);
  fixture = join(app.dataDir, "change.txt");
  try {
    const project = await json<Project>(await app.request("/api/projects", post({ name: "progressive policy" })), 201);
    const resource = (await json<Catalog>(await app.request("/api/catalog"), 200)).resources[0]!;
    const session = await json<WorkSession>(await app.request(`/api/projects/${project.id}/sessions`, post({ title: "policy" })), 201);
    const path = `/api/sessions/${session.id}`;
    const terminal = await json<TerminalSession>(await app.request(`${path}/terminals`, post({ resourceId: resource.id })), 201);
    const commands = `${path}/terminals/${terminal.id}/commands`;
    const read = () => app.request(`${path}/snapshot`).then(response => json<SessionSnapshot>(response, 200));
    await json<unknown>(await app.request(commands, post({ actor: "user", command: "pwd" })), 202);
    await until(async () => { const value = await read(); return value.terminals[0]!.status === "ready" ? value : null; });
    assert.equal((await app.request(commands, post({ actor: "user", command: `printf bad > '${fixture}'` }))).status, 400);
    assert.equal((await app.request(commands, post({ actor: "user", command: `rm -f '${fixture}'`, confirmed: true, risk: "readonly" }))).status, 400);
    await json<unknown>(await app.request(`${path}/terminals/${terminal.id}/control`, post({ holder: "agent" })), 200);
    await json<unknown>(await app.request(`${path}/messages`, post({ text: "read" })), 202);
    const collected = await until(async () => { const value = await read(); return value.session.status === "completed" ? value : null; });
    assert.equal(collected.actions.length, 0);
    const history = await json<TerminalHistory>(await app.request(`${path}/terminals/${terminal.id}/history`), 200);
    assert.deepEqual(history.entries.map(entry => entry.command), ["pwd", "ps aux | head -n 3", "uname -a"]);
    assert(history.entries.every(entry => entry.exitCode === 0));
    await json<unknown>(await app.request(`${path}/messages`, post({ text: "write" })), 202);
    const write = (await until(async () => { const value = await read(); return value.session.status === "waiting_approval" ? value : null; })).actions.find(action => action.status === "pending")!;
    assert.equal(write.risk, "write"); assert.equal(existsSync(fixture), false);
    await json<unknown>(await app.request(`/api/actions/${write.id}/decision`, post({ decision: "approve" })), 202);
    await until(async () => { const value = await read(); return value.session.status === "completed" ? value : null; });
    assert.equal(existsSync(fixture), true);
    await json<unknown>(await app.request(`${path}/messages`, post({ text: "danger" })), 202);
    const danger = (await until(async () => { const value = await read(); return value.session.status === "waiting_approval" ? value : null; })).actions.find(action => action.status === "pending")!;
    assert.equal(danger.risk, "dangerous");
    const decision = `/api/actions/${danger.id}/decision`;
    assert.equal((await app.request(decision, post({ decision: "approve", risk: "readonly" }))).status, 400);
    assert.equal((await app.request(decision, post({ decision: "approve", confirmation: "执行 another target" }))).status, 400);
    assert.equal((await read()).actions.find(action => action.id === danger.id)!.status, "pending"); assert.equal(existsSync(fixture), true);
    await json<unknown>(await app.request(decision, post({ decision: "approve", confirmation: `执行 ${resource.name}` })), 202);
    await until(async () => { const value = await read(); return value.session.status === "completed" ? value : null; });
    assert.equal(existsSync(fixture), false);
    assert.equal((await app.request(decision, post({ decision: "approve", confirmation: `执行 ${resource.name}` }))).status, 409);
  } finally { app.cleanup(); await new Promise<void>(done => mock.close(() => done())); }
});

void test("pending approval allows discussion without executing or replacing the command", async () => {
  let pendingContext: { message: string; conversation: Array<{ text: string }>; pendingOperations: Array<{ command: string }> } | undefined;
  let release!: () => void;
  const holdReply = new Promise<void>(done => { release = done; });
  const analysisGoals: string[] = [];
  const mock = createServer(async (request, response) => {
    let body = ""; for await (const chunk of request) body += chunk;
    const payload = JSON.parse(body) as { messages: Array<{ content: string }> };
    const system = payload.messages[0]!.content;
    const context = JSON.parse(payload.messages[1]!.content);
    let content: string;
    if (system.includes("Pending operations remain unapproved")) {
      if (context.message === "再解释一次") { response.writeHead(503); response.end(); return; }
      pendingContext = context;
      await holdReply;
      content = "这条命令会设置当前终端的环境变量，尚未执行，可以继续讨论。";
    } else if (isPlanRequest(body)) content = planReply("investigate");
    else if (isTerminalRequest(body)) content = JSON.stringify({ summary: "需要确认变更", steps: [{
      resourceId: context.resources[0].id, command: "export LAKE_TEST=discussion",
      reason: "开始调查", impact: "更改终端环境变量", verification: "检查环境变量",
    }] });
    else { analysisGoals.push(context.goal); content = JSON.stringify({ summary: "已记录命令结果", sourceIds: context.recordedTerminalHistory.map((item: { id: string }) => item.id), nextCheck: null }); }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
  await new Promise<void>(done => mock.listen(0, "127.0.0.1", done));
  const address = mock.address(); assert(address && typeof address !== "string");
  const app = await setup(`http://127.0.0.1:${address.port}/v1/chat/completions`);
  try {
    const project = await json<Project>(await app.request("/api/projects", post({ name: "discussion" })), 201);
    const session = await json<WorkSession>(await app.request(`/api/projects/${project.id}/sessions`, post({ title: "pending discussion" })), 201);
    const path = `/api/sessions/${session.id}`;
    const read = () => app.request(`${path}/snapshot`).then(response => json<SessionSnapshot>(response, 200));
    await json<unknown>(await app.request(`${path}/messages`, post({ text: "开始调查" })), 202);
    const initial = await until(async () => { const value = await read(); return value.session.status === "waiting_approval" ? value : null; });
    const action = initial.actions[0]!, terminal = initial.terminals[0]!;
    await json<unknown>(await app.request(`${path}/terminals/${terminal.id}/control`, post({ holder: "agent" })), 200);
    await json<unknown>(await app.request(`${path}/messages`, post({ text: "这个命令有什么影响？", resourceIds: [action.resourceId] })), 202);
    await until(async () => pendingContext ?? null);
    assert.equal(pendingContext!.pendingOperations[0]!.command, action.command);
    assert(pendingContext!.conversation.some(message => message.text === "开始调查"));
    assert.equal((await app.request(`${path}/messages`, post({ text: "并发提问" }))).status, 409);
    assert.equal((await app.request(`/api/actions/${action.id}/decision`, post({ decision: "approve" }))).status, 409);
    assert.equal((await app.request(`/api/actions/${action.id}/decision`, post({ decision: "reject" }))).status, 409);
    release();
    const discussed = await until(async () => { const value = await read(); return value.session.status === "waiting_approval" ? value : null; });
    assert(discussed.messages.some(message => message.role === "assistant" && message.text.includes("尚未执行")));
    assert.deepEqual(discussed.actions, initial.actions);
    assert.equal(discussed.specialists.length, initial.specialists.length);
    assert.equal(discussed.terminals[0]!.contextVersion, terminal.contextVersion);
    assert.equal((await json<TerminalHistory>(await app.request(`${path}/terminals/${terminal.id}/history`), 200)).entries.length, 0);
    await json<unknown>(await app.request(`${path}/messages`, post({ text: "再解释一次" })), 202);
    const failedReply = await until(async () => { const value = await read(); return value.session.status === "waiting_approval" ? value : null; });
    assert(failedReply.messages.some(message => message.role === "system" && message.text.includes("本次回复未完成")));
    assert.equal(failedReply.actions[0]!.status, "pending");
    await json<unknown>(await app.request(`/api/actions/${action.id}/decision`, post({ decision: "approve" })), 202);
    await until(async () => { const value = await read(); return value.session.status === "completed" ? value : null; });
    assert.deepEqual(analysisGoals, ["开始调查", "开始调查"]);
    const history = await json<TerminalHistory>(await app.request(`${path}/terminals/${terminal.id}/history`), 200);
    assert.equal(history.entries.length, 1); assert.equal(history.entries[0]!.command, action.command);
  } finally { release(); app.cleanup(); await new Promise<void>(done => mock.close(() => done())); }
});

void test("HTTP isolation, origin rejection, authenticated SSE replay and reconnect", async () => {
  const app = await setup();
  try {
    assert.equal((await fetch(`${app.base}/`)).status, 200);
    assert.equal((await fetch(`${app.base}/dashboard?session=unknown`)).status, 200);
    assert.equal((await fetch(`${app.base}/api/catalog`)).status, 401);
    assert.equal((await fetch(`${app.base}/api/bootstrap`)).status, 401);
    assert.equal((await app.request("/api/catalog", { headers: { Origin: "https://untrusted.example" } })).status, 403);
    const bootstrap = await json<{ authenticated: boolean; modelConfigured: boolean; modelName: string | null; terminalMode: string }>(await app.request("/api/bootstrap"), 200);
    assert.deepEqual(bootstrap, { authenticated: true, modelConfigured: false, modelName: null, terminalMode: "pty", aiRuntime: "legacy", supportsImageInput: false });
    const project = await json<Project>(await app.request("/api/projects", post({ name: "testing" })), 201);
    const catalog = await json<Catalog>(await app.request("/api/catalog"), 200);
    assert.equal(catalog.projects.length, 1);
    const resource = catalog.resources[0]!;
    const session = await json<WorkSession>(await app.request(`/api/projects/${project.id}/sessions`, post({ title: "case", resourceIds: [resource.id] })), 201);
    const snapshot = await json<SessionSnapshot>(await app.request(`/api/sessions/${session.id}/snapshot`), 200);
    assert.deepEqual(snapshot.session.resourceIds, [resource.id]);
    const stream = await app.request(`/api/sessions/${session.id}/events?after=0`);
    assert.equal(stream.status, 200);
    // Read one event without waiting for the stream to close.
    const reader = stream.body!.getReader();
    const first = await reader.read();
    assert.match(new TextDecoder().decode(first.value), /event: session/);
    await reader.cancel();
    const terminal = await json<TerminalSession>(await app.request(`/api/sessions/${session.id}/terminals`, post({ resourceId: resource.id })), 201);
    assert.equal((await app.request(`/api/sessions/${session.id}/terminals/${terminal.id}/commands`, post({ command: "export LAKE_TEST=write", actor: "user" }))).status, 400);
    const replay = await app.request(`/api/sessions/${session.id}/events?after=${snapshot.cursor}`);
    const replayReader = replay.body!.getReader();
    const chunk = await replayReader.read();
    const frame = new TextDecoder().decode(chunk.value);
    assert.match(frame, /event: terminal/);
    const event = JSON.parse(frame.match(/data: (\{[^\n]+\})/)![1]!) as SessionEvent;
    assert.equal(event.sessionId, session.id);
    assert(event.seq > snapshot.cursor);
    await replayReader.cancel();
    const wrong = await json<Project>(await app.request("/api/projects", post({ name: "other" })), 201);
    const otherResource = (await json<Catalog>(await app.request("/api/catalog"), 200)).resources.find((r) => r.projectId === wrong.id)!;
    assert.equal((await app.request(`/api/sessions/${session.id}/terminals`, post({ resourceId: otherResource.id }))).status, 404);
  } finally { app.cleanup(); }
});

void test("generated token bootstrap requires local development mode", async () => {
  const standalone = await setup(undefined, "generated");
  try {
    assert.equal((await standalone.request("/api/bootstrap")).status, 401);
  } finally { standalone.cleanup(); }

  const development = await setup(undefined, "dev");
  try {
    const bootstrap = await development.request("/api/bootstrap", { headers: { Origin: "http://localhost:5173" } });
    assert.equal(bootstrap.status, 200);
    const cookie = bootstrap.headers.get("set-cookie")?.split(";")[0];
    assert(cookie?.startsWith("lake_web_token="));
    assert.equal((await development.request("/api/catalog", { headers: { Origin: "http://localhost:5173" } })).status, 401);
    assert.equal((await development.request("/api/catalog", { headers: { Origin: "http://localhost:5173", Cookie: cookie } })).status, 200);
    assert.equal((await development.request("/api/bootstrap", { headers: { Origin: "https://untrusted.example" } })).status, 403);
  } finally { development.cleanup(); }
});

void test("model settings saved from the interface drive specialists without environment configuration", async () => {
  const authorizations: Array<string | undefined> = [];
  const modelRequests: string[] = [];
  const mock = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    authorizations.push(request.headers.authorization);
    modelRequests.push(body);
    if (isTerminalRequest(body)) {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ summary: "Existing evidence is sufficient", steps: [] }) } }] }));
      return;
    }
    if (isPlanRequest(body)) {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ choices: [{ message: { content: planReply("investigate") } }] }));
      return;
    }
    // Test-connection probes send a single ping message; investigations send two.
    const messages = (JSON.parse(body) as { messages: Array<{ content: string }> }).messages;
    const history = messages[1]
      ? (JSON.parse(messages[1].content) as { recordedTerminalHistory: Array<{ id: string }> }).recordedTerminalHistory
      : [];
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
      summary: "Settings-configured endpoint produced a recorded finding", sourceIds: history.map((entry) => entry.id), nextCheck: null,
    }) } }] }));
  });
  await new Promise<void>((done) => mock.listen(0, "127.0.0.1", done));
  const address = mock.address();
  assert(address && typeof address !== "string");
  const endpoint = `http://127.0.0.1:${address.port}/v1/chat/completions`;
  const app = await setup();
  try {
    const empty = await json<ModelSettings>(await app.request("/api/settings/model"), 200);
    assert.deepEqual(empty, { source: "none", configured: false, url: "", name: "", keyConfigured: false, protocol: "openai", supportsImageInput: false, supportsImageOutput: false });
    assert.equal((await app.request("/api/settings/model", { ...post({ url: "not-a-url", name: "m" }), method: "PUT" })).status, 400);
    assert.equal((await app.request("/api/settings/model", { ...post({ url: "ftp://example.com", name: "m" }), method: "PUT" })).status, 400);

    const saved = await app.request("/api/settings/model", { ...post({ url: endpoint, name: "test-model", apiKey: "secret-key-value" }), method: "PUT" });
    assert.equal(saved.status, 200);
    const savedBody = await saved.text();
    assert(!savedBody.includes("secret-key-value"));
    const settings = JSON.parse(savedBody) as ModelSettings;
    assert.deepEqual(settings, { source: "settings", configured: true, url: endpoint, name: "test-model", keyConfigured: true, protocol: "openai", supportsImageInput: false, supportsImageOutput: false });
    const file = join(app.dataDir, "model.json");
    assert.equal(statSync(file).mode & 0o777, 0o600);

    const bootstrap = await json<{ modelConfigured: boolean; modelName: string | null }>(await app.request("/api/bootstrap"), 200);
    assert.equal(bootstrap.modelConfigured, true);
    assert.equal(bootstrap.modelName, "test-model");

    const project = await json<Project>(await app.request("/api/projects", post({ name: "settings" })), 201);
    const resource = (await json<Catalog>(await app.request("/api/catalog"), 200)).resources[0]!;
    const session = await json<WorkSession>(await app.request(`/api/projects/${project.id}/sessions`, post({ title: "case" })), 201);
    const path = `/api/sessions/${session.id}/terminals`;
    const terminal = await json<TerminalSession>(await app.request(path, post({ resourceId: resource.id })), 201);
    await json<unknown>(await app.request(`${path}/${terminal.id}/commands`, post({ actor: "user", confirmed: true, command: "printf settings-observed" })), 202);
    await until(async () => {
      const history = await json<TerminalHistory>(await app.request(`${path}/${terminal.id}/history`), 200);
      return history.entries[0]?.exitCode === 0 ? history : null;
    });
    await json<unknown>(await app.request(`/api/sessions/${session.id}/messages`, post({ text: "Investigate with the saved settings" })), 202);
    await until(async () => {
      const result = await json<SessionSnapshot>(await app.request(`/api/sessions/${session.id}/snapshot`), 200);
      return result.session.status === "completed" ? result : null;
    });
    assert.equal(modelRequests.filter(isAnalystRequest).length, 2);
    assert(authorizations.every((value) => value === "Bearer secret-key-value"));

    const reachable = await json<ModelTestResult>(await app.request("/api/settings/model/test", post({ url: endpoint, name: "test-model", apiKey: "secret-key-value" })), 200);
    assert.deepEqual(reachable, { ok: true, message: "连接成功，模型返回了有效响应" });
    const baseUrl = endpoint.replace(/\/chat\/completions$/, "");
    const completed = await json<ModelTestResult>(await app.request("/api/settings/model/test", post({ url: baseUrl, name: "test-model" })), 200);
    assert.equal(completed.ok, true);
    assert.match(completed.message, /端点已补全为 .*\/chat\/completions/);
    const savedFromBase = await json<ModelSettings>(await app.request("/api/settings/model", { ...post({ url: baseUrl, name: "test-model" }), method: "PUT" }), 200);
    assert.equal(savedFromBase.url, endpoint);
    const unreachable = await json<ModelTestResult>(await app.request("/api/settings/model/test", post({ url: "http://127.0.0.1:9/v1/chat/completions", name: "test-model" })), 200);
    assert.equal(unreachable.ok, false);
    assert.match(unreachable.message, /无法连接端点/);
    assert.equal((await app.request("/api/settings/model/test", post({ url: "nope", name: "test-model" }))).status, 400);

    const kept = await json<ModelSettings>(await app.request("/api/settings/model", { ...post({ url: endpoint, name: "test-model" }), method: "PUT" }), 200);
    assert.equal(kept.keyConfigured, true);
    const replaced = await json<ModelSettings>(await app.request("/api/settings/model", { ...post({ url: endpoint, name: "test-model", apiKey: "" }), method: "PUT" }), 200);
    assert.equal(replaced.keyConfigured, false);

    const cleared = await json<ModelSettings>(await app.request("/api/settings/model", { method: "DELETE" }), 200);
    assert.deepEqual(cleared, { source: "none", configured: false, url: "", name: "", keyConfigured: false, protocol: "openai", supportsImageInput: false, supportsImageOutput: false });
    assert.equal(existsSync(file), false);
    const offline = await json<{ modelConfigured: boolean }>(await app.request("/api/bootstrap"), 200);
    assert.equal(offline.modelConfigured, false);
  } finally {
    app.cleanup();
    await new Promise<void>((done) => mock.close(() => done()));
  }
});

void test("deleting a session removes its record and is refused while a command runs", async () => {
  const app = await setup();
  try {
    const project = await json<Project>(await app.request("/api/projects", post({ name: "delete" })), 201);
    const resource = (await json<Catalog>(await app.request("/api/catalog"), 200)).resources[0]!;
    const session = await json<WorkSession>(await app.request(`/api/projects/${project.id}/sessions`, post({ title: "scratch" })), 201);
    const path = `/api/sessions/${session.id}`;
    const terminal = await json<TerminalSession>(await app.request(`${path}/terminals`, post({ resourceId: resource.id })), 201);
    await json<unknown>(await app.request(`${path}/terminals/${terminal.id}/commands`, post({ actor: "user", confirmed: true, command: "printf keep-me-visible" })), 202);
    await until(async () => {
      const history = await json<TerminalHistory>(await app.request(`${path}/terminals/${terminal.id}/history`), 200);
      return history.entries[0]?.exitCode === 0 ? history : null;
    });
    assert.equal((await json<SessionSnapshot>(await app.request(`${path}/snapshot`), 200)).terminals.length, 1);

    // A running command belongs to the session; deletion must wait for it.
    await json<unknown>(await app.request(`${path}/terminals/${terminal.id}/commands`, post({ actor: "user", confirmed: true, command: "sleep 5" })), 202);
    const refused = await app.request(path, { method: "DELETE" });
    assert.equal(refused.status, 409);
    assert.match(((await refused.json()) as { error: string }).error, /正在执行/);
    await app.request(`${path}/terminals/${terminal.id}/interrupt`, post({}));
    await until(async () => {
      const snapshot = await json<SessionSnapshot>(await app.request(`${path}/snapshot`), 200);
      // An interrupted command leaves the terminal disconnected, never busy.
      return snapshot.terminals[0]!.status !== "busy" ? snapshot : null;
    });

    const removed = await app.request(path, { method: "DELETE" });
    assert.equal(removed.status, 204);
    assert.equal((await app.request(`${path}/snapshot`)).status, 404);
    const catalog = await json<Catalog>(await app.request("/api/catalog"), 200);
    assert.equal(catalog.sessions.some((item) => item.id === session.id), false);
    assert.equal((await app.request(path, { method: "DELETE" })).status, 404);
  } finally { app.cleanup(); }
});

/** The main agent's routing call always mentions "main agent"; specialist calls name the role. */
const isPlanRequest = (body: string) => body.includes("You are the main agent of Lake");
const isTerminalRequest = (body: string) => body.includes("You are the terminal specialist");
const isAnalystRequest = (body: string) => body.includes("You are the host specialist") || body.includes("You are the logs specialist");
const planReply = (intent: "chat" | "investigate", reply = "") => JSON.stringify({ intent, reply });

void test("an empty session is answered by the main agent itself, mentions included", async () => {
  const requests: string[] = [];
  const mock = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    requests.push(body);
    const content = (JSON.parse(body) as { messages: Array<{ content: string }> }).messages[1]!.content;
    // The main agent composes the reply itself; the greeting and the resource
    // question each get a direct answer, never a fixed "no material" line.
    const reply = content.includes("你好")
      ? "你好，我是 Lake。告诉我现象，或先运行一条诊断命令。"
      : "Local machine 当前可用。会话里还没有命令记录，我可以先看进程或日志，只要你先运行一条命令。";
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ choices: [{ message: { content: planReply("chat", reply) } }] }));
  });
  await new Promise<void>((done) => mock.listen(0, "127.0.0.1", done));
  const address = mock.address();
  assert(address && typeof address !== "string");
  const app = await setup(`http://127.0.0.1:${address.port}/v1/chat/completions`);
  try {
    const project = await json<Project>(await app.request("/api/projects", post({ name: "turns" })), 201);
    const session = await json<WorkSession>(await app.request(`/api/projects/${project.id}/sessions`, post({ title: "greeting" })), 201);
    await json<unknown>(await app.request(`/api/sessions/${session.id}/messages`, post({ text: "你好" })), 202);
    const chatSnapshot = await until(async () => {
      const result = await json<SessionSnapshot>(await app.request(`/api/sessions/${session.id}/snapshot`), 200);
      return result.messages.length >= 2 ? result : null;
    });
    assert.equal(chatSnapshot.specialists.length, 0);
    assert.equal(chatSnapshot.session.status, "idle");
    assert.match(chatSnapshot.messages.at(-1)!.text, /你好，我是 Lake/);
    assert.equal(requests.length, 1);

    // An @-mention reaches the model as a structured resource reference.
    const resource = (await json<Catalog>(await app.request("/api/catalog"), 200)).resources.find((item) => item.projectId === project.id)!;
    await json<unknown>(await app.request(`/api/sessions/${session.id}/messages`, post({ text: "看看 @Local machine 的状态", resourceIds: [resource.id] })), 202);
    const mentionedSnapshot = await until(async () => {
      const result = await json<SessionSnapshot>(await app.request(`/api/sessions/${session.id}/snapshot`), 200);
      return result.messages.length >= 4 ? result : null;
    });
    assert.equal(mentionedSnapshot.specialists.length, 0);
    assert.match(mentionedSnapshot.messages.at(-1)!.text, /Local machine 当前可用/);
    const addressed = requests.at(-1)!;
    assert.match(addressed, /mentionedResources/);
    assert.match(addressed, new RegExp(resource.name));
    // A resource outside this session cannot be referenced.
    const otherProject = await json<Project>(await app.request("/api/projects", post({ name: "other" })), 201);
    const foreignResource = (await json<Catalog>(await app.request("/api/catalog"), 200)).resources.find((item) => item.projectId === otherProject.id)!;
    assert.equal((await app.request(`/api/sessions/${session.id}/messages`, post({ text: "看看它", resourceIds: [foreignResource.id] }))).status, 404);
    assert.equal((await app.request(`/api/sessions/${session.id}/messages`, post({ text: "看看", resourceIds: "nope" }))).status, 400);
    assert.equal(requests.some(isAnalystRequest), false);
  } finally {
    app.cleanup();
    await new Promise<void>((done) => mock.close(() => done()));
  }
});

void test("model specialists cite recorded commands and approval runs frozen action once", async () => {
  const modelRequests: unknown[] = [];
  const mock = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const value = JSON.parse(body) as { messages: Array<{ content: string }> };
    modelRequests.push(value);
    if (isTerminalRequest(body)) {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ summary: "Existing evidence is sufficient", steps: [] }) } }] }));
      return;
    }
    if (isPlanRequest(body)) {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ choices: [{ message: { content: planReply("investigate") } }] }));
      return;
    }
    const history = JSON.parse(value.messages[1]!.content) as { recordedTerminalHistory: Array<{ id: string }> };
    const specialist = value.messages[0]!.content.includes("host specialist") ? "host" : "logs";
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
      summary: `${specialist} sees recorded output; recovery remains unverified`, sourceIds: history.recordedTerminalHistory.map((entry) => entry.id),
      nextCheck: specialist === "host" && !value.messages[1]!.content.includes("frozen-check") ? { command: "export LAKE_TEST=frozen-check", reason: "Validate local observation", impact: "Reads no remote system", verification: "Compare another independent observation" } : null,
    }) } }] }));
  });
  await new Promise<void>((done) => mock.listen(0, "127.0.0.1", done));
  const address = mock.address();
  assert(address && typeof address !== "string");
  const app = await setup(`http://127.0.0.1:${address.port}/v1/chat/completions`);
  try {
    const project = await json<Project>(await app.request("/api/projects", post({ name: "testing" })), 201);
    const resource = (await json<Catalog>(await app.request("/api/catalog"), 200)).resources[0]!;
    const session = await json<WorkSession>(await app.request(`/api/projects/${project.id}/sessions`, post({ title: "case" })), 201);
    const path = `/api/sessions/${session.id}/terminals`;
    const terminal = await json<TerminalSession>(await app.request(path, post({ resourceId: resource.id })), 201);
    await json<unknown>(await app.request(`${path}/${terminal.id}/commands`, post({ actor: "user", confirmed: true, command: "printf observed-result" })), 202);
    await until(async () => {
      const history = await json<TerminalHistory>(await app.request(`${path}/${terminal.id}/history`), 200);
      return history.entries[0]?.exitCode === 0 ? history : null;
    });
    await json<unknown>(await app.request(`/api/sessions/${session.id}/messages`, post({ text: "Investigate observed output" })), 202);
    const snapshot = await until(async () => {
      const result = await json<SessionSnapshot>(await app.request(`/api/sessions/${session.id}/snapshot`), 200);
      return result.session.status === "waiting_approval" ? result : null;
    });
    // One routing call from the main agent, then one request per specialist.
    assert.equal(modelRequests.filter((value) => isPlanRequest(JSON.stringify(value))).length, 1);
    assert(snapshot.specialists.every(specialist => specialist.status === "completed"));
    assert.equal(snapshot.evidence.length, 2);
    assert(snapshot.evidence.every((item) => item.command === "printf observed-result"));
    assert.equal(snapshot.actions.length, 1);
    const action = snapshot.actions[0]!;
    assert.equal(action.command, "export LAKE_TEST=frozen-check");
    assert.equal((await app.request(`/api/actions/${action.id}/decision`, post({ decision: "approve" }))).status, 409);
    await json<TerminalSession>(await app.request(`${path}/${terminal.id}/control`, post({ holder: "agent" })), 200);
    const decision = `/api/actions/${action.id}/decision`;
    const [first, second] = await Promise.all([
      app.request(decision, post({ decision: "approve" })),
      app.request(decision, post({ decision: "approve" })),
    ]);
    assert.deepEqual([first.status, second.status].sort(), [202, 409]);
    await until(async () => {
      const history = await json<TerminalHistory>(await app.request(`${path}/${terminal.id}/history`), 200);
      return history.entries.length === 2 && history.entries[1]!.exitCode === 0 ? history : null;
    });
    const final = await until(async () => {
      const result = await json<SessionSnapshot>(await app.request(`/api/sessions/${session.id}/snapshot`), 200);
      return result.session.status === "completed" ? result : null;
    });
    assert.equal(final.actions[0]?.status, "succeeded");
    assert(final.messages.some(item => /不能证明故障已恢复/.test(item.text)));
    assert.equal((await app.request(decision, post({ decision: "reject" }))).status, 409);
  } finally {
    app.cleanup();
    await new Promise<void>((done) => mock.close(() => done()));
  }
});

void test("main agent dispatches terminal specialist on an empty session, then collects diagnostics and gates changes", async () => {
  const mock = createServer(async (request, response) => {
    let body = ""; for await (const chunk of request) body += chunk;
    const payload = JSON.parse(body) as { messages: Array<{ content: string }> };
    const context = JSON.parse(payload.messages[1]!.content) as {
      goal?: string; resources?: Array<{ id: string }>; recordedTerminalHistory?: Array<{ id: string }>;
    };
    let content: string;
    if (isPlanRequest(body)) content = planReply("investigate");
    else if (isTerminalRequest(body)) content = JSON.stringify({ summary: "Collect using a persistent terminal", steps: [{
      resourceId: context.resources![0]!.id,
      command: context.goal?.includes("change") ? "export LAKE_TEST=needs-approval" : "/bin/pwd",
      reason: "Inspect target", impact: "Model claims read-only", verification: "Inspect output and independently verify",
    }] });
    else content = JSON.stringify({ summary: "Observed command evidence; business health not verified", sourceIds: context.recordedTerminalHistory!.map(item => item.id), nextCheck: null });
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
  await new Promise<void>(resolve => mock.listen(0, "127.0.0.1", resolve));
  const address = mock.address(); assert(address && typeof address !== "string");
  const app = await setup(`http://127.0.0.1:${address.port}/v1/chat/completions`);
  try {
    const project = await json<Project>(await app.request("/api/projects", post({ name: "terminal agent" })), 201);
    const session = await json<WorkSession>(await app.request(`/api/projects/${project.id}/sessions`, post({ title: "fresh investigation" })), 201);
    const path = `/api/sessions/${session.id}`;
    const read = async () => json<SessionSnapshot>(await app.request(`${path}/snapshot`), 200);
    await json<unknown>(await app.request(`${path}/messages`, post({ text: "Inspect this host" })), 202);
    const pending = await until(async () => { const value = await read(); return value.session.status === "waiting_approval" ? value : null; });
    assert.equal(pending.specialists[0]!.name, "terminal"); assert.equal(pending.terminals.length, 1);
    const terminal = pending.terminals[0]!;
    const history = () => app.request(`${path}/terminals/${terminal.id}/history`).then(response => json<TerminalHistory>(response, 200));
    assert.equal((await history()).entries.length, 0);
    const action = pending.actions[0]!;
    assert.equal(action.terminalId, terminal.id);
    assert.equal((await app.request(`/api/actions/${action.id}/decision`, post({ decision: "approve" }))).status, 409);
    await json<unknown>(await app.request(`${path}/terminals/${terminal.id}/control`, post({ holder: "agent" })), 200);
    // Handoff automatically starts the read-only proposal without a second approval.
    await until(async () => { const value = await read(); return value.session.status === "completed" ? value : null; });
    assert.equal((await history()).entries[0]!.exitCode, 0);
    await json<unknown>(await app.request(`${path}/messages`, post({ text: "Inspect this host again" })), 202);
    const gathered = await until(async () => { const value = await read(); return value.session.status === "completed" ? value : null; });
    assert.equal((await history()).entries.length, 2);
    assert(gathered.evidence.some(item => gathered.specialists.find(role => role.id === item.specialistId)?.name === "terminal"));
    assert.equal((await app.request(`${path}/terminals/${terminal.id}/commands`, post({ actor: "agent", confirmed: true, command: "/bin/pwd" }))).status, 403);
    await json<unknown>(await app.request(`${path}/messages`, post({ text: "Please make a change" })), 202);
    const changed = await until(async () => { const value = await read(); return value.session.status === "waiting_approval" ? value : null; });
    const proposal = changed.actions.find(item => item.status === "pending")!;
    assert.equal(proposal.command, "export LAKE_TEST=needs-approval"); assert.equal((await history()).entries.length, 2);
    // Changing shell context invalidates a pending approval even when target and command match.
    await json<unknown>(await app.request(`${path}/terminals/${terminal.id}/control`, post({ holder: "user" })), 200);
    await json<unknown>(await app.request(`${path}/terminals/${terminal.id}/commands`, post({ actor: "user", confirmed: true, command: "cd /tmp" })), 202);
    await until(async () => { const value = await history(); return value.entries.at(-1)!.exitCode === 0 ? value : null; });
    await json<unknown>(await app.request(`${path}/terminals/${terminal.id}/control`, post({ holder: "agent" })), 200);
    assert.equal((await app.request(`/api/actions/${proposal.id}/decision`, post({ decision: "approve" }))).status, 409);
    assert.equal((await history()).entries.some(item => item.command === proposal.command), false);
    await json<unknown>(await app.request(`/api/actions/${proposal.id}/decision`, post({ decision: "reject" })), 200);
    await json<unknown>(await app.request(`${path}/terminals/${terminal.id}/control`, post({ holder: "user" })), 200);
    await json<unknown>(await app.request(`${path}/terminals/${terminal.id}/commands`, post({ actor: "user", confirmed: true, command: "printf waiting; read answer; printf completed" })), 202);
    await until(async () => { const value = await history(); return value.entries.at(-1)!.output.includes("waiting") ? value : null; });
    await json<unknown>(await app.request(`${path}/terminals/${terminal.id}/input`, post({ data: "done\n" })), 202);
    await until(async () => { const value = await history(); return value.entries.at(-1)!.exitCode === 0 ? value : null; });
    assert.match((await history()).entries.at(-1)!.output, /completed/);
  } finally { app.cleanup(); await new Promise<void>(resolve => mock.close(() => resolve())); }
});
