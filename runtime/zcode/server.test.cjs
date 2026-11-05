const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtemp, writeFile, readFile, access } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { createServer } = require("node:http");
process.env.LAKE_TS_IMPORT_ONLY = "1";
const { startLakeServer, previewLegacyMigration, rollbackMigration } = require("../../bin/lake-zcode/server.cjs");

async function fixture(t, mode = "text", legacyDev = false) {
  const home = await mkdtemp(join(tmpdir(), "lake-ts-test-"));
  const web = join(home, "web");
  await require("node:fs/promises").mkdir(web);
  await writeFile(join(web, "index.html"), "<html>Lake fixture</html>");
  let calls = 0;
  const requests = [];
  const target = join(home, "approved.txt");
  const provider = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const request = JSON.parse(Buffer.concat(chunks).toString());
    requests.push(request);
    calls++;
    const hasResult = request.messages.some((message) => message.role === "tool");
    let tool = mode === "write" && !hasResult;
    let delta = tool
      ? {
          tool_calls: [
            {
              index: 0,
              id: "write-fixture",
              type: "function",
              function: {
                name: "Write",
                arguments: JSON.stringify({ file_path: target, content: "approved" }),
              },
            },
          ],
        }
      : { content: "Lake TS 完成" };
    if (mode.startsWith("super")) {
      delta = superReply(request, mode, home);
      tool = !!delta.tool_calls;
    }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const deltas =
      mode === "secret"
        ? [{ content: "prefix synthetic-secret-" }, { content: "no-real-credential suffix" }]
        : [delta];
    for (const delta of deltas)
      res.write(
        `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta: { role: "assistant", ...delta }, finish_reason: null }] })}\n\n`,
      );
    res.write(
      `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } })}\n\n`,
    );
    res.end("data: [DONE]\n\n");
  });
  await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const options = { home, data: join(home, "data"), port: 0, staticRoot: web, development: legacyDev };
  if (legacyDev) {
    const fs = require("node:fs/promises");
    await fs.mkdir(options.data, { mode: 0o700 });
    await fs.mkdir(join(home, "secrets"), { mode: 0o700 });
    await writeFile(join(home, "secrets/provider-fixture.key"), "synthetic-secret-no-real-credential", { mode: 0o600 });
    await writeFile(join(options.data, "providers.json"), JSON.stringify({
      version: 1, activeProviderId: "legacy.fixture", activeModelId: "fixture", activeSource: "native",
      providers: [{
        id: "legacy.fixture", name: "Existing Dev provider", baseURL: `http://127.0.0.1:${provider.address().port}/v1`,
        protocol: "openai", enabled: true, credentialRef: "provider-fixture.key",
        models: [{ id: "fixture", name: "fixture", enabled: true }],
      }],
    }), { mode: 0o600 });
    await writeFile(join(options.data, "lake-web.sqlite"), "legacy database sentinel", { mode: 0o600 });
  }
  let app = await startLakeServer(options);
  t.after(async () => {
    await app.close();
    await new Promise((resolve) => provider.close(resolve));
  });
  const api = async (path, method = "GET", data, expected = 200) => {
    const response = await fetch(app.origin + path, {
      method,
      headers: {
        Authorization: `Bearer ${app.token}`,
        ...(data === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
    const value = await response.json();
    assert.equal(response.status, expected, JSON.stringify(value));
    return value;
  };
  if (!legacyDev) await api("/api/settings/model", "PUT", {
    url: `http://127.0.0.1:${provider.address().port}/v1/chat/completions`,
    name: "fixture",
    apiKey: "synthetic-secret-no-real-credential",
  });
  const project = await api("/api/projects", "POST", { name: "验证项目" });
  const session = await api(`/api/projects/${project.id}/sessions`, "POST", {});
  await api(`/api/sessions/${session.id}/ai/configure`, "POST", { maxSteps: 4 });
  const wait = async (statuses) => {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      const view = await api(`/api/sessions/${session.id}/ai`);
      if (statuses.includes(view.status)) return view;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.fail("timeout " + JSON.stringify(await api(`/api/sessions/${session.id}/ai`)));
  };
  return {
    home,
    target,
    project,
    session,
    api,
    wait,
    requests,
    options,
    get app() {
      return app;
    },
    get calls() {
      return calls;
    },
    async restart() {
      await app.close();
      app = await startLakeServer(options);
    },
  };
}

function superReply(request, mode, home) {
  const names = request.messages.flatMap((message) => (message.tool_calls ?? []).map((call) => call.function.name));
  const content = (message) => typeof message.content === "string" ? message.content : (message.content ?? []).map((part) => part.text ?? "").join("");
  const call = (name, input, id = name) => ({ tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(input) } }] });
  const router = request.tools?.some((tool) => tool.function?.name === "route_work");
  if (router) {
    const raw = [...request.messages].reverse().filter((message) => message.role === "user").map(content).find((text) => text.startsWith("[LAKE ADMITTED HUMAN EVENTS"));
    if (!raw) return { content: "Missing actual admitted event" };
    const event = JSON.parse(raw.split("\n")[1])[0];
    if (!names.includes("manage_specialist")) return call("manage_specialist", { event_id: event.id, part_key: "specialist", action: "create", role_key: "project-inspector", name: "项目检查员", duties: "检查当前项目工作区，按实际证据报告", quote: event.text });
    if (mode === "super-meta") return { content: "已创建长期专员，没有创建执行任务。" };
    if (!names.includes("list_specialists")) return call("list_specialists", {});
    const roleId = request.messages.filter((message) => message.role === "tool").map(content).join("\n").match(/"id"\s*:\s*"([a-f0-9]{64})"/)?.[1];
    if (!names.includes("route_work")) return call("route_work", { event_id: event.id, part_key: "inspect", action: "create", title: "检查项目工作区", role_id: roleId, quote: event.text, reason: "用户明确要求检查本项目" });
    return { content: "已交给项目检查员处理，执行结果将从原任务回报。" };
  }
  if (!names.includes("work_begin")) return call("work_begin", { title: "检查项目工作区", items: [{ id: "inspect", title: "读取工作区并按实际结果验收" }] });
  const updates = request.messages.flatMap((message) => (message.tool_calls ?? []).filter((call) => call.function.name === "work_update").map((call) => JSON.parse(call.function.arguments)));
  if (!updates.some((update) => update.status === "running")) return call("work_update", { item_id: "inspect", status: "running" }, "start-inspect");
  if (mode === "super-forged") {
    if (!updates.some((update) => update.status === "completed")) return call("work_update", { item_id: "inspect", status: "completed", evidence_ids: ["invented-success"] }, "forged-acceptance");
    return { content: "我已经完成并验收了任务。" };
  }
  if (mode === "super-read-recovery") {
    const reads = names.filter((name) => name === "list_project_files").length;
    if (!reads) return call("list_project_files", { path: "missing-diagnostic-path" }, "failed-files");
    if (updates.filter((update) => update.status === "running").length === 1) return call("work_update", { item_id: "inspect", status: "running" }, "retry-inspect");
    if (reads < 2) return call("list_project_files", { path: "." }, "actual-files");
  }
  if (!names.includes("list_project_files")) return call("list_project_files", { path: "." }, "actual-files");
  if (mode.includes("write") && !names.includes("Write")) {
    const raw = [...request.messages].reverse().filter((message) => message.role === "user").map(content).find((value) => value.startsWith("{") && value.includes('"assignment"'));
    const assigned = JSON.parse(raw);
    return call("Write", { file_path: join(home, "workspaces", assigned.assignment.projectId, "approved.txt"), content: "approved task output" }, "actual-write");
  }
  if (!updates.some((update) => update.status === "completed")) return call("work_update", { item_id: "inspect", status: "completed", evidence_ids: mode.includes("write") ? ["actual-files", "actual-write"] : ["actual-files"] }, "accept-inspect");
  if (!names.includes("work_finish")) return call("work_finish", { summary: "已读取本项目工作区，并根据本次实际文件清单完成检查。" });
  return { content: "本次真实检查已结束。" };
}

async function until(read, predicate, milliseconds = 15000) {
  const deadline = Date.now() + milliseconds;
  let value;
  while (Date.now() < deadline) {
    value = await read();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail("Timed out waiting for actual host state: " + JSON.stringify(value));
}

test("pure TS host authenticates, runs real ZCode, streams and restores history", async (t) => {
  const f = await fixture(t);
  assert.equal((await fetch(f.app.origin + "/api/catalog")).status, 401);
  assert.equal(
    (
      await fetch(f.app.origin + "/api/catalog", {
        headers: { Authorization: `Bearer ${f.app.token}`, Origin: "https://untrusted.invalid" },
      })
    ).status,
    403,
  );
  assert.equal((await f.api("/api/bootstrap")).backendRuntime, "typescript");
  await assert.rejects(startLakeServer(f.options), /已有后端/);
  await assert.rejects(
    startLakeServer({ ...f.options, data: join(f.home, "another-data") }),
    /已有后端/,
  );
  await f.api(
    `/api/sessions/${f.session.id}/messages`,
    "POST",
    { text: "Remember exact token LakeHistoryOne" },
    202,
  );
  const view = await f.wait(["completed", "failed"]);
  assert.equal(view.status, "completed", JSON.stringify(view));
  assert.ok(
    view.cards.some((card) => card.type === "message" && card.content.includes("Lake TS 完成")),
  );
  const snapshot = await f.api(`/api/sessions/${f.session.id}/snapshot`);
  assert.equal(snapshot.messages.length, 2);
  assert.ok(
    f.app.store
      .events(f.session.id, 0)
      .some((event) => event.textUpdate?.content.includes("Lake TS 完成")),
    "upstream stream must reach Lake events before the final snapshot",
  );
  const raw = await readFile(join(f.home, "data/lake-typescript.sqlite"));
  assert.ok(!raw.includes(Buffer.from("synthetic-secret-no-real-credential")));
  await f.restart();
  await f.api(
    `/api/sessions/${f.session.id}/messages`,
    "POST",
    { text: "Use the earlier token" },
    202,
  );
  const second = await f.wait(["completed", "failed"]);
  assert.equal(second.status, "completed", JSON.stringify(second));
  assert.ok(
    JSON.stringify(f.requests.at(-1)).includes("LakeHistoryOne"),
    "canonical ZCode history must survive restart",
  );
});

test("ZCode Write remains blocked until Lake approval and rejection has no side effect", async (t) => {
  const f = await fixture(t, "write");
  await f.api(
    `/api/sessions/${f.session.id}/messages`,
    "POST",
    { text: "Write the fixture file" },
    202,
  );
  let view = await f.wait(["waiting_approval", "failed", "completed"]);
  assert.equal(view.status, "waiting_approval", JSON.stringify(view));
  await assert.rejects(access(f.target));
  await f.api(`/api/sessions/${f.session.id}/ai/decision`, "POST", {
    id: view.pending.id,
    accept: false,
  });
  view = await f.wait(["completed", "failed"]);
  assert.equal(view.status, "completed", JSON.stringify(view));
  await assert.rejects(access(f.target));
  await f.api(
    `/api/sessions/${f.session.id}/messages`,
    "POST",
    { text: "Now write it after explicit approval" },
    202,
  );
  view = await f.wait(["waiting_approval", "failed", "completed"]);
  // The model fixture treats previous tool messages as completion; use a new session
  // for the independent positive write so a prior rejection cannot become a grant.
  const fresh = await f.api(`/api/projects/${f.project.id}/sessions`, "POST", {});
  await f.api(`/api/sessions/${fresh.id}/messages`, "POST", { text: "Write with approval" }, 202);
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    view = await f.api(`/api/sessions/${fresh.id}/ai`);
    if (view.status === "waiting_approval" || view.status === "failed") break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(view.status, "waiting_approval", JSON.stringify(view));
  await f.api(`/api/sessions/${fresh.id}/ai/decision`, "POST", {
    id: view.pending.id,
    accept: true,
  });
  while (Date.now() < deadline) {
    view = await f.api(`/api/sessions/${fresh.id}/ai`);
    if (["completed", "failed"].includes(view.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(view.status, "completed", JSON.stringify(view));
  assert.equal(await readFile(f.target, "utf8"), "approved");
});

test("cancelling a pending write cannot dispatch it or trigger another model request", async (t) => {
  const f = await fixture(t, "write");
  await f.api(`/api/sessions/${f.session.id}/messages`, "POST", { text: "Write the file" }, 202);
  const pending = await f.wait(["waiting_approval", "failed", "completed"]);
  assert.equal(pending.status, "waiting_approval", JSON.stringify(pending));
  const calls = f.calls;
  await f.api(`/api/sessions/${f.session.id}/ai/abort`, "POST", {});
  assert.equal((await f.wait(["cancelled"])).status, "cancelled");
  await f.api(
    `/api/sessions/${f.session.id}/ai/decision`,
    "POST",
    { id: pending.pending.id, accept: true },
    409,
  );
  assert.equal(f.calls, calls);
  await assert.rejects(access(f.target));
});

test("credentials split across provider chunks are removed before events and canonical persistence", async (t) => {
  const f = await fixture(t, "secret");
  await f.api(
    `/api/sessions/${f.session.id}/messages`,
    "POST",
    { text: "Render the response" },
    202,
  );
  const view = await f.wait(["completed", "failed"]);
  assert.equal(view.status, "completed", JSON.stringify(view));
  const secret = "synthetic-secret-no-real-credential";
  const canonical = await f.app.agents.sessions.messages({ sessionID: f.session.id });
  assert.ok(JSON.stringify(canonical).includes("[REDACTED]"), "the canonical upstream transcript must contain the safe replacement");
  const artifacts = [
    view,
    f.app.store.events(f.session.id, 0),
    canonical,
  ];
  assert.ok(!JSON.stringify(artifacts).includes(secret));
  assert.ok(JSON.stringify(artifacts).includes("[REDACTED]"));
});

test("session tags and icons preserve project scope, revisions, activity and restart state", async (t) => {
  const f = await fixture(t);
  const other = await f.api("/api/projects", "POST", { name: "Other" });
  const create = (project, name) => f.api(`/api/projects/${project}/tags`, "POST", { name, color: "purple" }, 201);
  const tag = await create(f.project.id, "Database");
  const foreign = await create(other.id, "External");
  const path = `/api/sessions/${f.session.id}/presentation`;
  const save = (data, status = 200) => f.api(path, "PUT", data, status);
  const before = (await f.api(`/api/sessions/${f.session.id}/snapshot`)).session;
  await save({ icon: "database", tagIds: [foreign.id], revision: 0 }, 404);
  await save({ icon: "javascript:alert(1)", tagIds: [], revision: 0 }, 400);
  await save({ icon: "database", tagIds: [tag.id, tag.id], revision: 0 }, 400);
  await save({ icon: "database", tagIds: [], revision: "0" }, 400);
  await save({ icon: "database", tagIds: [], revision: -1 }, 400);
  assert.equal(f.app.store.cursor(f.session.id), 0, "rejected edits must not emit events");
  let saved = await save({ icon: "database", tagIds: [tag.id], revision: 0 });
  assert.deepEqual(saved.tags, [tag]);
  assert.equal(saved.icon, "database");
  assert.equal(saved.presentationRevision, 1);
  assert.equal(saved.updatedAt, before.updatedAt);
  assert.equal(saved.status, before.status);
  await save({ icon: "chat", tagIds: [], revision: 0 }, 409);
  await f.restart();
  saved = (await f.api(`/api/sessions/${f.session.id}/snapshot`)).session;
  assert.deepEqual(saved.tags, [tag]);
  assert.equal(saved.presentationRevision, 1);
  const edited = await f.api(`/api/tags/${tag.id}`, "PUT", { name: "Data", color: "blue" });
  assert.deepEqual((await f.api(`/api/sessions/${f.session.id}/snapshot`)).session.tags, [edited]);
  // A model update holding an older session snapshot cannot overwrite metadata.
  f.app.store.put("sessions", before.id, { ...before, options: f.app.store.session(before.id).options });
  assert.equal(f.app.store.session(before.id).icon, "database");
  await f.api(`/api/tags/${tag.id}`, "DELETE");
  saved = (await f.api(`/api/sessions/${f.session.id}/snapshot`)).session;
  assert.deepEqual(saved.tags, []);
  assert.equal(saved.presentationRevision, 1);
  await save({ icon: "chat", tagIds: [tag.id], revision: 1 }, 404);
  await f.api(`/api/projects/${other.id}/tags`, "POST", { name: "External", color: "red" }, 409);
  await f.api(`/api/projects/${other.id}/tags`, "POST", { name: "Invalid", color: "url(evil)" }, 400);
  await f.api(`/api/projects/${other.id}/tags`, "POST", { name: " ".repeat(41) + "x", color: "blue" }, 400);
  assert.equal((await f.api("/api/catalog")).tags.length, 1);
  assert.equal(f.app.store.events(f.session.id, 0).length, 3);
});

test("session pinning and ordering preserve activity, enforce group scope and reject stale concurrent moves", async (t) => {
  const f = await fixture(t);
  const second = await f.api(`/api/projects/${f.project.id}/sessions`, "POST", {});
  const other = await f.api("/api/projects", "POST", { name: "Other" });
  const foreign = await f.api(`/api/projects/${other.id}/sessions`, "POST", {});
  const hidden = await f.api(`/api/projects/${f.project.id}/sessions`, "POST", {});
  f.app.store.put("aiScopes", hidden.id, { scope: "resource-terminal" });
  const move = (sessionId, pinned, beforeId, revision, status = 200) =>
    f.api(`/api/projects/${f.project.id}/session-navigation`, "POST", { sessionId, pinned, beforeId, revision }, status);
  await move(foreign.id, true, null, 0, 404);
  await move(hidden.id, true, null, 0, 404);
  await move(f.session.id, false, foreign.id, 0, 404);
  await move(f.session.id, false, f.session.id, 0, 400);
  await move(f.session.id, "true", null, 0, 400);
  await move(f.session.id, true, null, undefined, 400);
  const before = f.app.store.session(f.session.id);
  let saved = await move(f.session.id, false, second.id, 0);
  assert.equal(saved.navigationPosition, 0);
  assert.equal(f.app.store.session(second.id).navigationPosition, 1);
  assert.equal(saved.updatedAt, before.updatedAt);
  assert.equal(saved.status, before.status);
  await move(second.id, true, null, 0, 409);
  assert.equal(f.app.store.session(second.id).pinned, false);
  saved = await move(f.session.id, true, null, 1);
  assert.equal(saved.navigationRevision, 2);
  await move(second.id, false, f.session.id, 2, 404);
  saved = await move(second.id, true, f.session.id, 2);
  assert.equal(saved.navigationPosition, 0);
  assert.equal(f.app.store.session(f.session.id).navigationPosition, 1);
  await f.restart();
  assert.equal(f.app.store.session(second.id).pinned, true);
  const competing = await Promise.all([f.session.id, second.id].map(async (sessionId) => {
    const response = await fetch(`${f.app.origin}/api/projects/${f.project.id}/session-navigation`, {
      method: "POST",
      headers: { Authorization: `Bearer ${f.app.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, pinned: false, beforeId: null, revision: 3 }),
    });
    return { status: response.status, value: await response.json() };
  }));
  assert.deepEqual(competing.map((result) => result.status).sort(), [200, 409]);
  assert.equal(competing.find((result) => result.status === 200).value.navigationRevision, 4);
  const catalog = await f.api("/api/catalog");
  assert.ok(catalog.sessions.filter((s) => s.projectId === f.project.id).every((s) => s.navigationRevision === 4));
  const secondBefore = f.app.store.session(second.id);
  await f.api(`/api/sessions/${f.session.id}`, "DELETE");
  await move(second.id, false, f.session.id, 4, 404);
  assert.equal(f.app.store.session(second.id).navigationRevision, 4);
  assert.equal(f.app.store.session(second.id).pinned, secondBefore.pinned);
});

test("invalid JSON bodies cannot enter persistent navigation mutations", async (t) => {
  const f = await fixture(t);
  for (const body of ["null", "[]", "true", "", "{oops"]) {
    const response = await fetch(`${f.app.origin}/api/projects/${f.project.id}/tags`, {
      method: "POST",
      headers: { Authorization: `Bearer ${f.app.token}`, "Content-Type": "application/json" },
      body,
    });
    assert.equal(response.status, 400);
  }
  const response = await fetch(`${f.app.origin}/api/projects/${f.project.id}/tags`, {
    method: "POST",
    headers: { Authorization: `Bearer ${f.app.token}`, "Content-Type": "text/plain" },
    body: JSON.stringify({ name: "Wrong content type", color: "blue" }),
  });
  assert.equal(response.status, 415);
  assert.deepEqual((await f.api("/api/catalog")).tags, []);
});

test("explicit TS Dev imports model configuration once without copying credentials or touching the Go database", async (t) => {
  const f = await fixture(t, "text", true);
  const catalogFile = join(f.options.data, "providers.json");
  const oldCatalog = await readFile(catalogFile);
  const legacyKey = join(f.home, "secrets/provider-fixture.key");
  const bootstrap = await f.api("/api/bootstrap");
  assert.equal(bootstrap.backendRuntime, "typescript");
  assert.equal(bootstrap.modelConfigured, true);
  const catalog = await f.api("/api/settings/providers");
  assert.equal(catalog.activeProviderId, "legacy.fixture");
  assert.equal(catalog.providers[0].keyConfigured, true);
  assert.ok(!JSON.stringify(catalog).includes("credentialRef"));
  assert.ok(!JSON.stringify(catalog).includes("synthetic-secret"));
  await assert.rejects(access(join(f.home, "secrets/model-legacy.fixture.json")));
  await f.api(`/api/sessions/${f.session.id}/messages`, "POST", { text: "Use the existing Dev provider" }, 202);
  assert.equal((await f.wait(["completed", "failed"])).status, "completed");
  assert.equal(f.calls, 1);
  assert.deepEqual(await readFile(catalogFile), oldCatalog);
  assert.equal(await readFile(join(f.options.data, "lake-web.sqlite"), "utf8"), "legacy database sentinel");
  await f.api("/api/settings/providers/legacy.fixture", "DELETE");
  await f.restart();
  assert.deepEqual((await f.api("/api/settings/providers")).providers, [], "a deleted TS provider must not be reimported");
  assert.deepEqual(await readFile(catalogFile), oldCatalog);
  assert.equal(await readFile(legacyKey, "utf8"), "synthetic-secret-no-real-credential");
});

test("Dev opt-in never permits the production Home, and daily Dev still requires explicit opt-in", async (t) => {
  const f = await fixture(t);
  const userHome = require("node:os").homedir();
  await assert.rejects(startLakeServer({ ...f.options, home: join(userHome, ".lake"), development: true }), /独立 Home/);
  await assert.rejects(startLakeServer({ ...f.options, home: join(userHome, ".lake-dev"), development: false }), /独立 Home/);
});

test("real ZCode Pilot creates a stable specialist and independent Worker, with evidence-backed completion and persistent channels", async (t) => {
  const f = await fixture(t, "super-inspect");
  const project = await f.api(`/api/projects/${f.project.id}/superagent`, "POST", {});
  const again = await f.api(`/api/projects/${f.project.id}/superagent`, "POST", {});
  assert.equal(project.routerSessionId, again.routerSessionId);
  const workspace = await f.app.store.workspace(f.project.id);
  await writeFile(join(workspace, "actual-evidence.txt"), "real fixture file");
  await f.api(`/api/sessions/${project.routerSessionId}/messages`, "POST", { text: "请创建项目检查员，并检查这个项目工作区的实际文件。" }, 202);
  const result = await until(() => f.api(`/api/projects/${f.project.id}/superagent`), (result) => result.workers.some((worker) => worker.task.state === "completed"));
  assert.equal(result.active, true);
  assert.equal(result.workers.length, 1);
  const worker = result.workers[0];
  assert.equal(worker.task.acceptanceState, "pass");
  assert.notEqual(worker.sessionId, project.routerSessionId);
  assert.equal(result.channels.length, 1);
  assert.equal(result.channels[0].roleId, worker.roleId);
  const snapshot = await f.api(`/api/sessions/${worker.sessionId}/snapshot`);
  assert.equal(snapshot.session.workspaceRole, "worker");
  assert.equal(snapshot.superagent.task.taskId, worker.task.taskId);
  assert.equal(snapshot.superagent.goal.items[0].status, "completed");
  const operations = f.app.store.list("superOperations");
  assert.equal(operations.length, 1);
  assert.equal(operations[0].status, "succeeded");
  assert.ok(JSON.stringify(operations[0].output).includes("actual-evidence.txt"));
  assert.equal(f.app.store.list("superAcceptance").filter((receipt) => receipt.scope === "goal").length, 1);
  const routerRequest = f.requests.find((request) => request.tools?.some((tool) => tool.function.name === "route_work"));
  assert.ok(!routerRequest.tools.some((tool) => ["Bash", "Read", "Write", "Agent"].includes(tool.function.name)), "Pilot must have no resource execution tools");
  const channel = await f.api(`/api/sessions/${result.channels[0].sessionId}/channel`);
  assert.ok(channel.entries.some((entry) => entry.message?.author?.workerId === worker.id));
  await f.restart();
  const restored = await f.api(`/api/projects/${f.project.id}/superagent`);
  assert.equal(restored.project.routerSessionId, project.routerSessionId);
  assert.equal(restored.channels[0].id, result.channels[0].id);
  assert.equal(restored.workers[0].task.state, "completed");
  const calls = f.calls;
  await new Promise((resolve) => setTimeout(resolve, 75));
  assert.equal(f.calls, calls, "restart must not replay an accepted task");
});

test("specialist metadata management creates a channel without a task or Worker execution session", async (t) => {
  const f = await fixture(t, "super-meta");
  const project = await f.api(`/api/projects/${f.project.id}/superagent`, "POST", {});
  await f.api(`/api/sessions/${project.routerSessionId}/messages`, "POST", { text: "创建项目检查员，先不要分派实际任务。" }, 202);
  const result = await until(() => f.api(`/api/projects/${f.project.id}/superagent`), (result) => result.channels.length === 1);
  await until(() => f.api(`/api/sessions/${project.routerSessionId}/ai`), (view) => view.status === "completed");
  assert.equal(result.workers.length, 0);
  assert.equal(f.app.store.list("superGoals").length, 0);
  const sessions = await f.api("/api/catalog");
  assert.ok(!sessions.sessions.some((session) => session.workspaceRole === "worker"));
  assert.equal((await f.app.agents.sessions.listSessions({})).length, 1);
});

test("stopping a real specialist invalidates its pending Write approval without dispatch or restart replay", async (t) => {
  const f = await fixture(t, "super-write");
  const project = await f.api(`/api/projects/${f.project.id}/superagent`, "POST", {});
  await f.api(`/api/sessions/${project.routerSessionId}/messages`, "POST", { text: "检查项目并创建一个结果文件，需要批准后再写入。" }, 202);
  const state = await until(() => f.api(`/api/projects/${f.project.id}/superagent`), (result) => result.workers.length === 1 && result.channels[0]?.needsConfirmation);
  const worker = state.workers[0], channel = state.channels[0];
  const pending = (await f.api(`/api/sessions/${worker.sessionId}/ai`)).pending;
  assert.equal(pending.call.name, "Write");
  const target = join(f.home, "workspaces", f.project.id, "approved.txt");
  await assert.rejects(access(target));
  await f.api(`/api/sessions/${channel.sessionId}/channel`, "POST", { action: "stop" });
  await f.api(`/api/sessions/${worker.sessionId}/ai/decision`, "POST", { id: pending.id, accept: true }, 409);
  await assert.rejects(access(target));
  const stopped = await f.api(`/api/projects/${f.project.id}/superagent`);
  assert.equal(stopped.workers[0].task.state, "cancelled");
  const calls = f.calls;
  await f.restart();
  assert.equal((await f.api(`/api/projects/${f.project.id}/superagent`)).workers[0].task.state, "cancelled");
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(f.calls, calls);
  await assert.rejects(access(target));
});

test("a current Pilot permission change fences a previously presented Worker approval", async (t) => {
  const f = await fixture(t, "super-write");
  const project = await f.api(`/api/projects/${f.project.id}/superagent`, "POST", {});
  await f.api(`/api/sessions/${project.routerSessionId}/messages`, "POST", { text: "检查项目并生成结果文件。" }, 202);
  const state = await until(() => f.api(`/api/projects/${f.project.id}/superagent`), (result) => result.workers.length === 1 && result.channels[0]?.needsConfirmation);
  const worker = state.workers[0];
  const pending = (await f.api(`/api/sessions/${worker.sessionId}/ai`)).pending;
  await f.api(`/api/sessions/${project.routerSessionId}/ai/configure`, "POST", { denyLocalExecution: true });
  await f.api(`/api/sessions/${worker.sessionId}/ai/decision`, "POST", { id: pending.id, accept: true });
  await until(() => f.api(`/api/projects/${f.project.id}/superagent`), (result) => result.workers[0].assignmentState !== "active");
  await assert.rejects(access(join(f.home, "workspaces", f.project.id, "approved.txt")));
  assert.ok(!f.app.store.list("superAcceptance").some((receipt) => receipt.scope === "goal"));
});

test("specialist retirement is scoped, revisioned, idempotent and preserves committed task history", async (t) => {
  const f = await fixture(t, "super-inspect");
  const project = await f.api(`/api/projects/${f.project.id}/superagent`, "POST", {});
  await f.api(`/api/sessions/${project.routerSessionId}/messages`, "POST", { text: "请检查这个项目工作区。" }, 202);
  const state = await until(() => f.api(`/api/projects/${f.project.id}/superagent`), (result) => result.workers.some((worker) => worker.task.state === "completed"));
  const role = state.channels[0], task = state.workers[0];
  const other = await f.api("/api/projects", "POST", { name: "Other project" });
  await f.api(`/api/projects/${other.id}/superagent/specialists/${role.roleId}`, "DELETE", { revision: role.roleRevision }, 404);
  await f.api(`/api/projects/${f.project.id}/superagent/specialists/${role.roleId}`, "DELETE", { revision: role.roleRevision + 1 }, 409);
  for (let retry = 0; retry < 2; retry++) await f.api(`/api/projects/${f.project.id}/superagent/specialists/${role.roleId}`, "DELETE", { revision: role.roleRevision });
  const retired = await f.api(`/api/projects/${f.project.id}/superagent`);
  assert.equal(retired.channels.length, 0);
  assert.equal(retired.workers[0].task.state, "completed");
  assert.equal(retired.workers[0].task.taskId, task.task.taskId);
  assert.ok((await f.api(`/api/sessions/${role.sessionId}/channel`)).entries.length > 0);
});

async function seedLegacyCatalog(f) {
  const { DatabaseSync } = require("node:sqlite");
  const { mkdir, chmod } = require("node:fs/promises");
  const { createHash } = require("node:crypto");
  await mkdir(join(f.options.data, "adk"), { mode: 0o700 });
  await mkdir(join(f.options.data, "ai"), { mode: 0o700 });
  const path = join(f.options.data, "lake-web.sqlite"), runtimePath = join(f.options.data, "adk/sessions.sqlite");
  const web = new DatabaseSync(path);
  web.exec(`CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT,createdAt TEXT);
    CREATE TABLE resources(id TEXT PRIMARY KEY,projectId TEXT,name TEXT,kind TEXT,status TEXT);
    CREATE TABLE sessions(id TEXT PRIMARY KEY,projectId TEXT,title TEXT,status TEXT,createdAt TEXT,updatedAt TEXT);
    CREATE TABLE messages(id TEXT PRIMARY KEY,sessionId TEXT,role TEXT,text TEXT,createdAt TEXT,images TEXT,files TEXT);
    INSERT INTO projects VALUES('old-project','已有项目','2026-01-01T00:00:00Z');
    INSERT INTO resources VALUES('old-ssh','old-project','原主机','ssh','available');
    INSERT INTO sessions VALUES('old-router','old-project','Pilot','idle','2026-01-01T00:00:00Z','2026-01-02T00:00:00Z');
    INSERT INTO sessions VALUES('old-channel','old-project','检查员','idle','2026-01-01T00:00:00Z','2026-01-02T00:00:00Z');
    INSERT INTO sessions VALUES('old-worker','old-project','历史检查','completed','2026-01-01T00:00:00Z','2026-01-02T00:00:00Z');
    INSERT INTO messages VALUES('old-message','old-worker','user','原始要求','2026-01-01T00:00:00Z','[]','[]');`);
  web.close();
  const runtime = new DatabaseSync(runtimePath);
  runtime.exec(`CREATE TABLE superagent_projects(project_id TEXT,router_session_id TEXT,version INTEGER);
    CREATE TABLE superagent_roles(id TEXT,project_id TEXT,role_key TEXT,name TEXT,duties TEXT,revision INTEGER,deleted_at TEXT);
    CREATE TABLE superagent_role_channels(id TEXT,project_id TEXT,role_id TEXT,host_session_id TEXT,revision INTEGER,created_at TEXT);
    CREATE TABLE superagent_workers(id TEXT,project_id TEXT,role_id TEXT,session_id TEXT,task_id TEXT,source_event_id TEXT,role_snapshot TEXT,created_at TEXT,revision INTEGER);
    CREATE TABLE native_work_goals(id TEXT,session_id TEXT,data TEXT,status TEXT);
    CREATE TABLE sessions(app_name TEXT,user_id TEXT,id TEXT,state TEXT);
    CREATE TABLE native_history_migrations(session_id TEXT,runtime_session_id TEXT,status TEXT,created_at TEXT);
    CREATE TABLE native_artifacts(session_id TEXT,file_name TEXT,version INTEGER,part BLOB);
    INSERT INTO superagent_projects VALUES('old-project','old-router',1);
    INSERT INTO superagent_roles VALUES('old-role','old-project','inspector','检查员','检查项目',7,NULL);
    INSERT INTO superagent_role_channels VALUES('old-channel-id','old-project','old-role','old-channel',1,'2026-01-01T00:00:00Z');
    INSERT INTO superagent_workers VALUES('old-worker-id','old-project','old-role','old-worker','old-goal','old-event','{"name":"原检查员","revision":6}','2026-01-01T00:00:00Z',1);
    INSERT INTO native_history_migrations VALUES('old-worker','old-adk','complete','2026-01-01T00:00:00Z');`);
  runtime.prepare("INSERT INTO native_work_goals VALUES(?,?,?,?)").run("old-goal", "old-worker", JSON.stringify({ id: "old-goal", sessionId: "old-worker", status: "completed", title: "旧任务", revision: 9, items: [], modelRounds: 4, roundLimit: 500, deadlineAt: "2026-01-02T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" }), "completed");
  const cards = Array.from({ length: 351 }, (_, index) => ({ id: `old-card-${index}`, type: "message", content: `已提交历史 ${index}`, at: "2026-01-01T00:00:00Z", status: "completed" }));
  cards[0].content += " synthetic-secret-no-real-credential";
  const projection = JSON.stringify({ view: { session: "old-worker", cards }, runtime: { dangerousOldLease: true }, config: { apiKey: "must-not-import" } });
  const hash = createHash("sha256").update(projection).digest("hex");
  runtime.prepare("INSERT INTO sessions VALUES('lake','lake','old-adk',?)").run(JSON.stringify({ lake_context_projection: { version: 2, hash, eventId: "committed-event" } }));
  runtime.prepare("INSERT INTO native_artifacts VALUES('old-adk','lake-context.json',2,?)").run(Buffer.from(JSON.stringify({ text: projection })));
  runtime.prepare("INSERT INTO native_artifacts VALUES('old-adk','lake-context.json',3,?)").run(Buffer.from(JSON.stringify({ text: JSON.stringify({ view: { session: "old-worker", cards: [{ id: "orphan", content: "UNCOMMITTED" }] } }) })));
  runtime.close();
  for (const file of [path, runtimePath]) await chmod(file, 0o600);
  await writeFile(join(f.options.data, "ai/old-worker.json"), JSON.stringify({ runtime: { sessionId: "old-adk" }, view: { session: "old-worker", cards: [{ id: "stale", type: "message", content: "STALE UI CACHE" }] } }), { mode: 0o600 });
  return { path, runtimePath, hash: async (file) => createHash("sha256").update(await readFile(file)).digest("hex") };
}

test("Go Dev catalog migration preserves identity and committed paginated history without executing legacy tasks", async (t) => {
  const f = await fixture(t), source = await seedLegacyCatalog(f);
  const before = await Promise.all([source.hash(source.path), source.hash(source.runtimePath)]);
  f.options.development = true; f.options.importLegacy = true;
  const calls = f.calls;
  await f.restart();
  const state = await f.api("/api/projects/old-project/superagent");
  assert.equal(state.project.routerSessionId, "old-router");
  assert.equal(state.channels[0].roleId, "old-role");
  assert.equal(state.channels[0].roleRevision, 7);
  assert.equal(state.workers[0].id, "old-worker-id");
  assert.equal(state.workers[0].assignmentState, "archived");
  const snapshot = await f.api("/api/sessions/old-worker/snapshot");
  assert.equal(snapshot.session.workspaceRole, "legacy");
  assert.equal(snapshot.ai.cards.length, 300);
  assert.equal(snapshot.ai.totalCards, 351);
  assert.equal(snapshot.ai.cardsOffset, 51);
  assert.equal(snapshot.superagent.task.taskId, "old-goal");
  const earlier = await f.api("/api/sessions/old-worker/ai/snapshot?before=51");
  assert.equal(earlier.cards.length, 51);
  assert.equal(earlier.cards[0].id, "old-card-0");
  assert.ok(!JSON.stringify(earlier).includes("synthetic-secret-no-real-credential"));
  assert.ok(!JSON.stringify(snapshot).includes("UNCOMMITTED"));
  assert.ok(!JSON.stringify(snapshot).includes("STALE UI CACHE"));
  assert.equal(f.app.store.get("legacyLoadedViews", "old-worker").source, "go-adk-committed-projection");
  assert.equal(f.app.store.list("superWorkers").length, 0);
  assert.equal(f.app.store.list("superGoals").length, 0);
  assert.equal(f.app.store.list("superOperations").length, 0);
  const channel = await f.api("/api/sessions/old-channel/channel");
  assert.equal(channel.entries.length, 50);
  const second = await f.api(`/api/sessions/old-channel/channel?cursor=${encodeURIComponent(channel.nextCursor)}`);
  assert.equal(new Set([...channel.entries, ...second.entries].map((entry) => entry.id)).size, 100);
  await f.api("/api/sessions/old-worker/messages", "POST", { text: "重放旧任务" }, 409);
  await f.api("/api/sessions/old-router", "DELETE", undefined, 409);
  await f.restart();
  assert.equal((await f.api("/api/projects/old-project/superagent")).workers.length, 1);
  assert.deepEqual(await Promise.all([source.hash(source.path), source.hash(source.runtimePath)]), before);
  assert.equal(f.calls, calls);
});

test("legacy migration rollback refuses changed user data and removes only unchanged imported records", async (t) => {
  const f = await fixture(t); await seedLegacyCatalog(f);
  const preview = await previewLegacyMigration(f.app.store);
  assert.equal(preview.counts.projects, 1);
  f.options.development = true; f.options.importLegacy = true; await f.restart();
  const batch = f.app.store.get("settings", "legacyCatalogMigration.v1");
  const original = f.app.store.get("projects", "old-project");
  f.app.store.put("projects", "old-project", { ...original, name: "用户的新修改" });
  assert.throws(() => rollbackMigration(f.app.store, batch.id), /已变更/);
  f.app.store.put("projects", "old-project", original);
  await f.api("/api/sessions/old-worker/snapshot");
  assert.equal(rollbackMigration(f.app.store, batch.id).rolledBack, true);
  assert.equal(f.app.store.get("projects", "old-project"), undefined);
  assert.equal(f.app.store.get("views", "old-worker"), undefined);
  assert.equal(f.app.store.get("legacyLoadedViews", "old-worker"), undefined);
  assert.equal(f.app.store.project(f.project.id).id, f.project.id);
});

test("Plan mode confirms its exact plan but never grants mutation tools", async (t) => {
  const f = await fixture(t, "super-inspect"), project = await f.api(`/api/projects/${f.project.id}/superagent`, "POST", {});
  await f.api(`/api/sessions/${project.routerSessionId}/ai/configure`, "POST", { conversationMode: "plan" });
  await f.api(`/api/sessions/${project.routerSessionId}/messages`, "POST", { text: "先制定计划，确认后只读检查。" }, 202);
  const state = await until(() => f.api(`/api/projects/${f.project.id}/superagent`), (result) => result.workers.length === 1 && result.channels[0].needsConfirmation);
  const worker = state.workers[0], view = await f.api(`/api/sessions/${worker.sessionId}/ai`);
  assert.equal(view.pending.kind, "work_plan");
  assert.equal(f.app.store.list("superOperations").length, 0);
  const catalog = f.requests.find((request) => request.tools?.some((tool) => tool.function.name === "work_begin")).tools.map((tool) => tool.function.name);
  assert.ok(!catalog.includes("Write") && !catalog.includes("Edit") && !catalog.includes("Bash"));
  await f.api(`/api/sessions/${worker.sessionId}/ai/decision`, "POST", { id: view.pending.id, accept: true });
  await until(() => f.api(`/api/projects/${f.project.id}/superagent`), (result) => result.workers[0].task.state === "completed");
  assert.equal(f.app.store.list("superOperations").length, 1);
  assert.equal(f.app.store.list("superOperations")[0].tool, "list_project_files");
});

test("rejecting a Plan confirmation has no resource effects and cannot be approved after restart", async (t) => {
  const f = await fixture(t, "super-inspect"), project = await f.api(`/api/projects/${f.project.id}/superagent`, "POST", {});
  await f.api(`/api/sessions/${project.routerSessionId}/ai/configure`, "POST", { conversationMode: "plan" });
  await f.api(`/api/sessions/${project.routerSessionId}/messages`, "POST", { text: "先提计划。" }, 202);
  const state = await until(() => f.api(`/api/projects/${f.project.id}/superagent`), (result) => result.channels[0]?.needsConfirmation);
  const worker = state.workers[0], view = await f.api(`/api/sessions/${worker.sessionId}/ai`);
  await f.api(`/api/sessions/${worker.sessionId}/ai/decision`, "POST", { id: view.pending.id, accept: false });
  await until(() => f.api(`/api/projects/${f.project.id}/superagent`), (result) => result.workers[0].assignmentState !== "active");
  assert.equal(f.app.store.list("superOperations").length, 0);
  await f.restart();
  const calls = f.calls;
  await f.api(`/api/sessions/${worker.sessionId}/ai/decision`, "POST", { id: view.pending.id, accept: true }, 409);
  assert.equal(f.calls, calls);
});

test("Worker prose and invented evidence cannot accept or complete a canonical goal", async (t) => {
  const f = await fixture(t, "super-forged"), project = await f.api(`/api/projects/${f.project.id}/superagent`, "POST", {});
  await f.api(`/api/sessions/${project.routerSessionId}/messages`, "POST", { text: "检查项目，必须按实际结果交付。" }, 202);
  await until(() => f.api(`/api/projects/${f.project.id}/superagent`), (result) => result.workers.length === 1 && result.workers[0].assignmentState !== "active" && result.workers[0].assignmentState !== "queued");
  const goal = f.app.store.list("superGoals")[0];
  assert.notEqual(goal.status, "completed");
  assert.notEqual(goal.acceptanceState, "pass");
  assert.equal(f.app.store.list("superAcceptance").length, 0);
  assert.equal(f.app.store.list("superOperations").length, 0);
});

test("Pilot object pages enforce current project, revision and hash, including digest revisions", async (t) => {
  const f = await fixture(t, "super-inspect"), project = await f.api(`/api/projects/${f.project.id}/superagent`, "POST", {});
  await f.api(`/api/sessions/${project.routerSessionId}/messages`, "POST", { text: "检查项目工作区。" }, 202);
  const state = await until(() => f.api(`/api/projects/${f.project.id}/superagent`), (result) => result.workers[0]?.task.state === "completed");
  const goal = f.app.store.list("superGoals")[0];
  const read = f.app.superagent.profile(project.routerSessionId).tools.find((entry) => entry.metadata.name === "read_super_object").handler;
  const context = { toolCallId: "read-check", abortSignal: new AbortController().signal };
  const page = await read({ kind: "task_digest", id: goal.id, limit: 16384 }, context);
  assert.equal(page.revision, goal.revision);
  assert.ok(Buffer.byteLength(page.content) <= 1536);
  await assert.rejects(async () => read({ kind: "task_digest", id: goal.id, revision: goal.revision + 1 }, context), /revision/);
  await assert.rejects(async () => read({ kind: "task", id: goal.id, expected_hash: "invalid" }, context), /hash/);
  const other = await f.api("/api/projects", "POST", { name: "另一个项目" });
  const otherPilot = await f.api(`/api/projects/${other.id}/superagent`, "POST", {});
  const foreignRead = f.app.superagent.profile(otherPilot.routerSessionId).tools.find((entry) => entry.metadata.name === "read_super_object").handler;
  await assert.rejects(async () => foreignRead({ kind: "task", id: goal.id }, context), /not found in project/);
  assert.ok((await f.api(`/api/sessions/${state.channels[0].sessionId}/channel`)).entries.some((entry) => entry.message?.dispatch?.taskId === goal.id));
});

test("closing the established Home gate fences pending approvals through reopening and restart", async (t) => {
  const f = await fixture(t, "super-write"), fs = require("node:fs/promises");
  await fs.mkdir(join(f.home, "security"), { mode: 0o700 });
  await fs.mkdir(join(f.options.data, "adk"), { mode: 0o700 });
  const control = { formatVersion: 1, storeID: "a".repeat(64), recoveryEpoch: "b".repeat(64), runtimeRoot: await fs.realpath(join(f.options.data, "adk")), gate: "open", storeReady: false };
  const path = join(f.home, "security/control.json");
  await writeFile(path, JSON.stringify(control), { mode: 0o600 });
  const project = await f.api(`/api/projects/${f.project.id}/superagent`, "POST", {});
  await f.api(`/api/sessions/${project.routerSessionId}/messages`, "POST", { text: "检查并生成项目文件。" }, 202);
  const state = await until(() => f.api(`/api/projects/${f.project.id}/superagent`), (result) => result.channels[0]?.needsConfirmation);
  const worker = state.workers[0], pending = (await f.api(`/api/sessions/${worker.sessionId}/ai`)).pending;
  await writeFile(path, JSON.stringify({ ...control, gate: "closed" }), { mode: 0o600 });
  assert.equal((await f.api("/api/bootstrap")).recoveryReadOnly, true);
  await f.api(`/api/sessions/${worker.sessionId}/ai/decision`, "POST", { id: pending.id, accept: true }, 409);
  await writeFile(path, JSON.stringify(control), { mode: 0o600 });
  await f.api(`/api/sessions/${worker.sessionId}/ai/decision`, "POST", { id: pending.id, accept: true }, 409);
  await f.restart();
  assert.equal((await f.api("/api/bootstrap")).recoveryReadOnly, false);
  await f.api(`/api/sessions/${worker.sessionId}/ai/decision`, "POST", { id: pending.id, accept: true }, 409);
  await assert.rejects(access(join(f.home, "workspaces", f.project.id, "approved.txt")));
});

test("migrated project policies cannot be replaced by default ZCode allow rules", async (t) => {
  const f = await fixture(t, "super-inspect");
  f.app.store.put("legacyProjectPolicies", f.project.id, { revision: 4, mode: "restricted", readOnly: true });
  const project = await f.api(`/api/projects/${f.project.id}/superagent`, "POST", {});
  await f.api(`/api/sessions/${project.routerSessionId}/messages`, "POST", { text: "检查项目。" }, 202);
  await until(() => f.api(`/api/projects/${f.project.id}/superagent`), (result) => result.workers.length === 1 && !["active", "queued"].includes(result.workers[0].assignmentState));
  assert.equal(f.app.store.list("superOperations").length, 0);
  assert.equal(f.app.store.list("superAcceptance").length, 0);
  assert.equal(f.app.store.list("superGoals")[0].acceptanceState, "not_evaluated");
});

test("current read and write switches apply to independent Worker tools and persist", async (t) => {
  const f = await fixture(t, "super-write"), project = await f.api(`/api/projects/${f.project.id}/superagent`, "POST", {});
  await f.api(`/api/sessions/${project.routerSessionId}/ai/configure`, "POST", { silentReadFiles: false, silentWriteFiles: true });
  await f.api(`/api/sessions/${project.routerSessionId}/messages`, "POST", { text: "检查并生成本项目文件。" }, 202);
  const state = await until(() => f.api(`/api/projects/${f.project.id}/superagent`), (result) => result.channels[0]?.needsConfirmation);
  const worker = state.workers[0], pending = (await f.api(`/api/sessions/${worker.sessionId}/ai`)).pending;
  assert.equal(pending.call.name, "list_project_files");
  assert.equal(f.app.store.list("superOperations").length, 0);
  await f.api(`/api/sessions/${worker.sessionId}/ai/decision`, "POST", { id: pending.id, accept: true });
  await until(() => f.api(`/api/projects/${f.project.id}/superagent`), (result) => result.workers[0].task.state === "completed");
  assert.equal(await readFile(join(f.home, "workspaces", f.project.id, "approved.txt"), "utf8"), "approved task output");
  assert.equal(f.app.store.list("superOperations").length, 2);
  await f.restart();
  assert.equal((await f.api(`/api/sessions/${project.routerSessionId}/ai/options`)).silentWriteFiles, true);
});

test("a failed proven read obtains a fresh attempt without replaying the failure or resetting the original task", async (t) => {
  const f = await fixture(t, "super-read-recovery"), project = await f.api(`/api/projects/${f.project.id}/superagent`, "POST", {});
  await f.api(`/api/sessions/${project.routerSessionId}/messages`, "POST", { text: "检查这个项目，路径不可用时改用现有工作区诊断。" }, 202);
  await until(() => f.api(`/api/projects/${f.project.id}/superagent`), (result) => result.workers[0]?.task.state === "completed");
  const goals = f.app.store.list("superGoals"), operations = f.app.store.list("superOperations"), attempts = f.app.store.list("superAttempts");
  assert.equal(goals.length, 1);
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0].state, "failed");
  assert.equal(attempts[1].retryOf, attempts[0].id);
  assert.equal(attempts[1].state, "succeeded");
  assert.deepEqual(operations.map((operation) => operation.status), ["failed", "succeeded"]);
  assert.equal(goals[0].acceptanceState, "pass");
  assert.equal(goals[0].roundLimit, 500);
  assert.equal(f.app.store.list("superWorkers").length, 1);
});
