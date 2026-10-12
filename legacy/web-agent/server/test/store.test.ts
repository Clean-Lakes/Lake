import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Coordinator } from "../src/coordinator.js";
import { ApiFailure, Store } from "../src/store.js";
import { TerminalService } from "../src/terminal.js";

function isolatedStore(): { store: Store; dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "lake-web-test-"));
  const store = new Store(dir);
  return { store, dir, cleanup: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

const fails = (fn: () => unknown, status: number) => assert.throws(fn, (error) => error instanceof ApiFailure && error.status === status);

void test("project and session resources stay scoped and events replay in order", () => {
  const { store, cleanup } = isolatedStore();
  try {
    const first = store.createProject("alpha");
    const second = store.createProject("beta");
    const resources = store.catalog().resources;
    const local = resources.find((r) => r.projectId === first.id)!;
    const other = resources.find((r) => r.projectId === second.id)!;
    fails(() => store.createSession(first.id, "wrong resource", [other.id]), 400);
    const session = store.createSession(first.id, "check local", [local.id]);
    fails(() => store.createTerminal(session.id, other.id), 404);
    const terminal = store.createTerminal(session.id, local.id);
    store.addMessage(session.id, "user", "What happened?");
    const events = store.events(session.id, 0);
    assert.deepEqual(events.map((event) => event.type), ["session", "terminal", "message"]);
    assert.deepEqual(store.events(session.id, events[0]!.seq).map((event) => event.seq), events.slice(1).map((event) => event.seq));
    assert.equal(store.snapshot(session.id).cursor, events.at(-1)!.seq);
    assert.equal(store.history(session.id, terminal.id).terminal.resourceId, local.id);
    assert.equal(store.catalog().sessions.length, 1);
  } finally { cleanup(); }
});

void test("one decision per action, holder enforced, running action becomes unknown on restart", () => {
  const { store, dir } = isolatedStore();
  let resumed: Store | undefined;
  try {
    const project = store.createProject("testing");
    const resource = store.catalog().resources[0]!;
    const session = store.createSession(project.id, "action", [resource.id]);
    const terminal = store.createTerminal(session.id, resource.id);
    const action = store.addAction(session.id, resource.id, "date", "Inspect time", "Read only", "Compare clock");
    const approved = store.decideAction(action.id, "approve");
    assert.equal(approved.command, "date");
    fails(() => store.decideAction(action.id, "approve"), 409);
    fails(() => store.decideAction(action.id, "reject"), 409);
    fails(() => store.beginCommand(session.id, terminal.id, "agent", "date"), 409);
    store.controlTerminal(session.id, terminal.id, "agent");
    const entry = store.beginCommand(session.id, terminal.id, "agent", action.command, action.id);
    assert.equal(store.terminal(session.id, terminal.id).status, "busy");
    assert.equal(store.controlTerminal(session.id, terminal.id, "user").holder, "user");
    store.db.prepare("UPDATE terminals SET holder='agent' WHERE id=?").run(terminal.id);
    fails(() => store.beginCommand(session.id, terminal.id, "user", "pwd"), 409);
    store.close();
    resumed = new Store(dir);
    assert.equal(resumed.terminal(session.id, terminal.id).status, "disconnected");
    assert.equal(resumed.action(action.id).status, "unknown");
    assert.equal(resumed.history(session.id, terminal.id).entries[0]?.id, entry.id);
    assert.equal(resumed.history(session.id, terminal.id).entries[0]?.exitCode, null);
    assert.equal(resumed.session(session.id).status, "failed");
    fails(() => resumed!.decideAction(action.id, "approve"), 409);
  } finally { resumed?.close(); rmSync(dir, { recursive: true, force: true }); }
});

void test("unconfigured coordinator records an explicit unavailable outcome", async () => {
  const { store, dir, cleanup } = isolatedStore();
  const originalUrl = process.env.LAKE_WEB_MODEL_URL;
  const originalName = process.env.LAKE_WEB_MODEL_NAME;
  const originalDir = process.env.LAKE_WEB_DATA_DIR;
  try {
    delete process.env.LAKE_WEB_MODEL_URL;
    delete process.env.LAKE_WEB_MODEL_NAME;
    // Saved settings live in the data directory; point it at the isolated one so a
    // developer's real model.json cannot make this test pass or fail by accident.
    process.env.LAKE_WEB_DATA_DIR = dir;
    const project = store.createProject("testing");
    const session = store.createSession(project.id, "model state");
    store.beginInvestigation(session.id, "Investigate");
    const coordinator = new Coordinator(store);
    assert.equal(coordinator.configured(), false);
    await coordinator.runTurn(session.id, "Investigate");
    const snapshot = store.snapshot(session.id);
    assert.equal(snapshot.session.status, "failed");
    assert.match(snapshot.messages[1]!.text, /尚未配置 Agent 模型/);
    assert.equal(snapshot.specialists.length, 0);
    assert.equal(snapshot.actions.length, 0);
  } finally {
    if (originalUrl === undefined) delete process.env.LAKE_WEB_MODEL_URL; else process.env.LAKE_WEB_MODEL_URL = originalUrl;
    if (originalName === undefined) delete process.env.LAKE_WEB_MODEL_NAME; else process.env.LAKE_WEB_MODEL_NAME = originalName;
    if (originalDir === undefined) delete process.env.LAKE_WEB_DATA_DIR; else process.env.LAKE_WEB_DATA_DIR = originalDir;
    cleanup();
  }
});

void test("deleting a session removes every recorded row", () => {
  const { store, cleanup } = isolatedStore();
  try {
    const project = store.createProject("testing");
    const resource = store.catalog().resources[0]!;
    const session = store.createSession(project.id, "scratch", [resource.id]);
    const terminal = store.createTerminal(session.id, resource.id);
    store.addMessage(session.id, "user", "check this");
    const specialist = store.addSpecialist(session.id, "host", "task");
    store.finishSpecialist(specialist.id, "completed", "done");
    const action = store.addAction(session.id, resource.id, "date", "reason", "impact", "verification");
    store.decideAction(action.id, "approve");
    store.controlTerminal(session.id, terminal.id, "agent");
    const entry = store.beginCommand(session.id, terminal.id, "agent", "date", action.id);
    store.finishCommand(session.id, terminal.id, entry.id, "Sat", 0, false);
    store.completeAction(action.id, "succeeded", 0);
    store.addEvidence(specialist.id, resource.id, "recorded", entry);
    const count = (table: string) => (store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    assert.equal(count("events") > 0, true);

    store.deleteSession(session.id);

    for (const table of ["sessions", "sessionResources", "messages", "specialists", "evidence", "actions", "terminals", "terminalEntries", "events"]) {
      assert.equal(count(table), 0, `${table} should be empty after deletion`);
    }
    fails(() => store.session(session.id), 404);
    fails(() => store.deleteSession(session.id), 404);
    assert.equal(store.catalog().sessions.length, 0);
    assert.equal(store.catalog().resources.length, 1);
  } finally { cleanup(); }
});

void test("deleting a session is refused while its terminal is busy", () => {
  const { store, cleanup } = isolatedStore();
  try {
    const project = store.createProject("testing");
    const resource = store.catalog().resources[0]!;
    const session = store.createSession(project.id, "busy", [resource.id]);
    const terminal = store.createTerminal(session.id, resource.id);
    store.beginCommand(session.id, terminal.id, "user", "sleep 30");
    fails(() => store.deleteSession(session.id), 409);
    store.finishCommand(session.id, terminal.id, store.history(session.id, terminal.id).entries[0]!.id, "done", 0, false);
    store.deleteSession(session.id);
    assert.equal(store.catalog().sessions.length, 0);
  } finally { cleanup(); }
});

void test("persistent PTY records output and refuses a second writer", async () => {
  const { store, cleanup } = isolatedStore();
  const service = new TerminalService(store);
  try {
    const project = store.createProject("testing");
    const resource = store.catalog().resources[0]!;
    const session = store.createSession(project.id, "terminal");
    const terminal = store.createTerminal(session.id, resource.id);
    await service.execute(session.id, terminal.id, "user", "printf lake-pty-test");
    await assert.rejects(service.execute(session.id, terminal.id, "user", "pwd"), (error) => error instanceof ApiFailure && error.status === 409);
    const deadline = Date.now() + 5000;
    while (store.terminal(session.id, terminal.id).status === "busy" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const history = store.history(session.id, terminal.id);
    assert.equal(history.terminal.status, "ready");
    assert.equal(history.entries.length, 1);
    assert.match(history.entries[0]!.output, /lake-pty-test/);
    assert.equal(history.entries[0]!.exitCode, 0);
    await service.execute(session.id, terminal.id, "user", "sleep 10");
    service.interrupt(session.id, terminal.id);
    fails(() => service.interrupt(session.id, terminal.id), 409);
    const deadline2 = Date.now() + 5000;
    while (store.terminal(session.id, terminal.id).status === "busy" && Date.now() < deadline2) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const interrupted = store.history(session.id, terminal.id);
    assert.equal(interrupted.terminal.status, "disconnected");
    assert.match(interrupted.entries[1]!.output, /Interrupted by user/);
    assert.equal(interrupted.entries[1]!.exitCode, null);
  } finally { service.shutdown(); cleanup(); }
});
