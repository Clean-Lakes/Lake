const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtemp, writeFile, readFile, access } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { createServer } = require("node:http");
process.env.LAKE_TS_IMPORT_ONLY = "1";
const { startLakeServer } = require("../../bin/lake-zcode/server.cjs");

async function fixture(t, mode = "text") {
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
    const tool = mode === "write" && !hasResult;
    const delta = tool
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
  const options = { home, data: join(home, "data"), port: 0, staticRoot: web };
  let app = await startLakeServer(options);
  t.after(async () => {
    await app.close();
    await new Promise((resolve) => provider.close(resolve));
  });
  const api = async (path, method = "GET", data, expected = 200) => {
    const response = await fetch(app.origin + path, {
      method,
      headers: { Authorization: `Bearer ${app.token}`, "Content-Type": "application/json" },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
    const value = await response.json();
    assert.equal(response.status, expected, JSON.stringify(value));
    return value;
  };
  await api("/api/settings/model", "PUT", {
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
  await f.api(`/api/tags/${tag.id}`, "DELETE", {});
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
  await f.api(`/api/sessions/${f.session.id}`, "DELETE", {});
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
