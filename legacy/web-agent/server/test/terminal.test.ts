import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { ApiFailure, Store } from "../src/store.js";
import { TerminalService, DIAGNOSTICS } from "../src/terminal.js";
import { TerminalSpecialist } from "../src/terminal-specialist.js";
import { sshConfig, sshArguments } from "../src/ssh.js";

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "lake-live-terminal-"));
  const store = new Store(dir); const service = new TerminalService(store);
  const project = store.createProject("fixture"); const resource = store.catalog().resources[0]!;
  const session = store.createSession(project.id, "persistent shell");
  return { dir, store, service, resource, session,
    cleanup: () => { service.shutdown(); store.close(); rmSync(dir, { recursive: true, force: true }); } };
}
const denied = (code: number) => (error: unknown) => error instanceof ApiFailure && error.status === code;
async function until(check: () => boolean) {
  const end = Date.now() + 5000;
  while (!check()) { if (Date.now() > end) throw Error("Timed out"); await new Promise(resolve => setTimeout(resolve, 20)); }
}

void test("persistent shell preserves cwd/exported state, failure codes and streamed output", async () => {
  const ctx = setup(); const { store, service, resource, session } = ctx;
  try {
    const terminal = await service.open(session.id, resource.id);
    const first = await service.execute(session.id, terminal.id, "user", `cd '${ctx.dir}'; export LAKE_FIXTURE_VALUE='persistent'`);
    assert.equal((await service.wait(session.id, terminal.id, first.id)).exitCode, 0);
    const second = await service.execute(session.id, terminal.id, "user", 'printf "$LAKE_FIXTURE_VALUE:"; pwd; false');
    const result = await service.wait(session.id, terminal.id, second.id);
    assert.equal(result.exitCode, 1); assert.match(result.output, /persistent:/); assert(result.output.includes(ctx.dir));
    const slow = await service.execute(session.id, terminal.id, "user", "printf first-part; sleep 0.5; printf last-part");
    await until(() => store.history(session.id, terminal.id).entries.at(-1)!.output.includes("first-part"));
    assert.equal(store.terminal(session.id, terminal.id).status, "busy");
    await assert.rejects(service.execute(session.id, terminal.id, "user", "pwd"), denied(409));
    assert.match((await service.wait(session.id, terminal.id, slow.id)).output, /first-part.*last-part/);
    assert(!store.history(session.id, terminal.id).output.includes("LAKE_DONE_"));
  } finally { ctx.cleanup(); }
});

void test("interactive programs accept user input and terminal resizing", async () => {
  const ctx = setup(); const { store, service, resource, session } = ctx;
  try {
    const terminal = await service.open(session.id, resource.id);
    assert.throws(() => service.input(session.id, terminal.id, "ignored\n"), denied(409));
    const entry = await service.execute(session.id, terminal.id, "user", 'printf waiting; read answer; printf "accepted:%s" "$answer"');
    await until(() => store.history(session.id, terminal.id).entries[0]!.output.includes("waiting"));
    service.input(session.id, terminal.id, "hello\n");
    const result = await service.wait(session.id, terminal.id, entry.id);
    assert.equal(result.exitCode, 0); assert.match(result.output, /accepted:hello/);
    service.resize(session.id, terminal.id, 80, 24);
    assert.throws(() => service.resize(session.id, terminal.id, 1, 24), denied(400));
  } finally { ctx.cleanup(); }
});

void test("takeover revokes Agent input during a command and marks its outcome uncertain", async () => {
  const ctx = setup(); const { store, service, resource, session } = ctx;
  try {
    const terminal = await service.open(session.id, resource.id); service.control(session.id, terminal.id, "agent");
    const action = store.addAction(session.id, resource.id, "printf active; sleep 0.5; printf completed", "fixture", "change", "verify", terminal.id);
    store.decideAction(action.id, "approve");
    const entry = await service.execute(session.id, terminal.id, "agent", action.command, action.id);
    await until(() => store.history(session.id, terminal.id).entries[0]!.output.includes("active"));
    assert.equal(service.control(session.id, terminal.id, "user").holder, "user");
    await assert.rejects(service.execute(session.id, terminal.id, "agent", DIAGNOSTICS.directory!), denied(409));
    assert.equal((await service.wait(session.id, terminal.id, entry.id)).exitCode, null);
    assert.equal(store.action(action.id).status, "unknown");
    assert.equal(store.terminal(session.id, terminal.id).holder, "user");
    await assert.rejects(service.execute(session.id, terminal.id, "agent", DIAGNOSTICS.directory!), denied(409));
    const manual = await service.execute(session.id, terminal.id, "user", "printf manual");
    assert.equal((await service.wait(session.id, terminal.id, manual.id)).exitCode, 0);
  } finally { ctx.cleanup(); }
});

void test("execution policy rejects claimed diagnostics, stale contexts, altered commands and reused approvals", async () => {
  const ctx = setup(); const { store, service, resource, session } = ctx;
  try {
    const terminal = await service.open(session.id, resource.id); service.control(session.id, terminal.id, "agent");
    await assert.rejects(service.execute(session.id, terminal.id, "agent", "/bin/pwd; touch /tmp/should-never-exist"), denied(403));
    const stale = store.addAction(session.id, resource.id, "printf frozen", "fixture", "change", "verify", terminal.id);
    const entry = await service.execute(session.id, terminal.id, "agent", DIAGNOSTICS.directory!);
    await service.wait(session.id, terminal.id, entry.id);
    assert.throws(() => store.terminalForAction(stale), denied(409)); store.decideAction(stale.id, "reject");
    const action = store.addAction(session.id, resource.id, "printf approved", "fixture", "change", "verify", terminal.id);
    store.decideAction(action.id, "approve");
    await assert.rejects(service.execute(session.id, terminal.id, "agent", "printf tampered", action.id), denied(403));
    const approved = await service.execute(session.id, terminal.id, "agent", action.command, action.id);
    await service.wait(session.id, terminal.id, approved.id);
    await assert.rejects(service.execute(session.id, terminal.id, "agent", action.command, action.id), denied(403));
    assert.equal(store.history(session.id, terminal.id).entries.filter(item => item.command === action.command).length, 1);
  } finally { ctx.cleanup(); }
});

void test("terminal specialist collects diagnostics but proposes other commands without execution", async () => {
  const ctx = setup(); const { store, service, resource, session } = ctx;
  try {
    const terminal = await service.open(session.id, resource.id); service.control(session.id, terminal.id, "agent");
    const specialist = new TerminalSpecialist(store, service);
    const result = await specialist.collect(session.id, { summary: "collect", steps: [
      { resourceId: resource.id, command: DIAGNOSTICS.directory!, reason: "cwd", impact: "read", verification: "output" },
      { resourceId: resource.id, command: "export LAKE_APPROVAL_TEST=changed", reason: "test", impact: "model says read-only", verification: "output" },
    ] });
    assert.equal(result.evidence.length, 1); assert.equal(result.pending, true);
    const snapshot = store.snapshot(session.id);
    assert.equal(snapshot.specialists[0]!.name, "terminal"); assert.equal(snapshot.actions[0]!.status, "pending");
    assert.equal(snapshot.actions[0]!.terminalId, terminal.id); assert.equal(store.history(session.id, terminal.id).entries.length, 1);
    assert.throws(() => specialist.parse({ summary: "bad", steps: [{ resourceId: "foreign", command: "pwd" }] }, snapshot.resources));
  } finally { ctx.cleanup(); }
});

void test("automatic checks preserve literal arguments and bypass modified PATH and shell functions", async () => {
  const ctx = setup(); const { store, service, resource, session } = ctx;
  try {
    const terminal = await service.open(session.id, resource.id);
    const manual = await service.execute(session.id, terminal.id, "user", "pwd() { printf fake-function; }; PATH=/tmp; export PATH");
    await service.wait(session.id, terminal.id, manual.id);
    service.control(session.id, terminal.id, "agent");
    const entry = await service.execute(session.id, terminal.id, "agent", "pwd; printf '%s' 'literal $HOME' | cat; printf '%s' ';' cat /tmp/must-not-be-read");
    const result = await service.wait(session.id, terminal.id, entry.id);
    assert.equal(result.exitCode, 0); assert.doesNotMatch(result.output, /fake-function/);
    assert.match(result.output, /literal \$HOME/);
    assert.match(result.output, /;cat\/tmp\/must-not-be-read/);
    assert.equal(store.snapshot(session.id).actions.length, 0);
  } finally { ctx.cleanup(); }
});

void test("shell exit and interruption disconnect without replay", async () => {
  const ctx = setup(); const { store, service, resource, session } = ctx;
  try {
    const terminal = await service.open(session.id, resource.id);
    const exit = await service.execute(session.id, terminal.id, "user", "exit 7");
    assert.equal((await service.wait(session.id, terminal.id, exit.id)).exitCode, null);
    assert.equal(store.terminal(session.id, terminal.id).status, "disconnected");
    await assert.rejects(service.execute(session.id, terminal.id, "user", "pwd"), denied(409));
    const fresh = await service.open(session.id, resource.id);
    const running = await service.execute(session.id, fresh.id, "user", "sleep 10"); service.interrupt(session.id, fresh.id);
    assert.equal((await service.wait(session.id, fresh.id, running.id)).exitCode, null);
    assert.equal(store.terminal(session.id, fresh.id).status, "disconnected");
  } finally { ctx.cleanup(); }
});

void test("SSH paths, permissions and arguments enforce explicit credentials and host trust", () => {
  const previousHome = process.env.HOME; const dir = mkdtempSync(join(tmpdir(), "lake-ssh-credential-"));
  try {
    process.env.HOME = dir; mkdirSync(join(dir, ".lake", "secrets"), { recursive: true, mode: 0o700 });
    const key = join(dir, ".lake", "secrets", "fixture.key"); writeFileSync(key, "synthetic fixture only", { mode: 0o600 });
    const ssh = sshConfig({ host: "127.0.0.1", username: "fixture", identityFile: "fixture.key", port: 2222 });
    const argv = sshArguments(ssh);
    for (const arg of ["StrictHostKeyChecking=yes", "IdentityAgent=none", "BatchMode=yes", "/dev/null", ssh.identityFile]) assert(argv.includes(arg));
    assert.equal(argv.at(-1), "exec /bin/sh");
    assert.throws(() => sshConfig({ ...ssh, host: "-oProxyCommand=bad" }), denied(400));
    assert.throws(() => sshConfig({ ...ssh, username: "root;bad" }), denied(400));
    assert.throws(() => sshConfig({ ...ssh, identityFile: "/etc/passwd" }), denied(400));
    chmodSync(key, 0o644); assert.throws(() => sshConfig(ssh), denied(400));
  } finally { if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome; rmSync(dir, { recursive: true, force: true }); }
});

void test("prototype database migrates without losing records or foreign keys", () => {
  const ctx = setup(); const { store, resource, session } = ctx;
  const terminal = store.createTerminal(session.id, resource.id); const entry = store.beginCommand(session.id, terminal.id, "user", "printf previous");
  store.finishCommand(session.id, terminal.id, entry.id, "previous", 0, false); store.close();
  const db = new DatabaseSync(join(ctx.dir, "lake-web.sqlite")); db.exec("PRAGMA foreign_keys=OFF");
  for (const table of ["resources", "terminals"]) {
    const schema = (db.prepare("SELECT sql FROM sqlite_master WHERE name=?").get(table) as { sql: string }).sql;
    const legacy = schema.replace("CHECK(kind IN ('local','ssh'))", "CHECK(kind = 'local')")
      .replace("CHECK(status IN ('connecting','ready','busy','disconnected','unknown'))", "CHECK(status IN ('ready','busy','disconnected','unknown'))");
    db.exec(legacy.replace(new RegExp(`^CREATE TABLE "?${table}"?`), `CREATE TABLE ${table}_old`));
    db.exec(`INSERT INTO ${table}_old SELECT * FROM ${table}; DROP TABLE ${table}; ALTER TABLE ${table}_old RENAME TO ${table}`);
  }
  db.exec("ALTER TABLE actions DROP COLUMN terminalId; ALTER TABLE actions DROP COLUMN contextVersion; ALTER TABLE terminals DROP COLUMN contextVersion; ALTER TABLE terminals DROP COLUMN output"); db.close();
  const reopened = new Store(ctx.dir);
  try {
    assert.equal(reopened.resource(resource.id).kind, "local"); assert.equal(reopened.history(session.id, terminal.id).entries[0]!.output, "previous");
    assert.deepEqual(reopened.db.prepare("PRAGMA foreign_key_check").all(), []); assert.equal(reopened.terminal(session.id, terminal.id).status, "disconnected");
  } finally { reopened.close(); rmSync(ctx.dir, { recursive: true, force: true }); }
});
