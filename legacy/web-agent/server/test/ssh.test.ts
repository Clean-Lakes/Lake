import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Store } from "../src/store.js";
import { TerminalService } from "../src/terminal.js";

void test("real OpenSSH fixture preserves remote shell state and refuses an untrusted host", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lake-ssh-fixture-"));
  const oldHome = process.env.HOME;
  let store: Store | undefined; let service: TerminalService | undefined;
  let sshd: ReturnType<typeof spawn> | undefined;
  try {
    process.env.HOME = dir;
    mkdirSync(join(dir, ".lake", "secrets"), { recursive: true, mode: 0o700 }); mkdirSync(join(dir, ".ssh"), { mode: 0o700 });
    const key = join(dir, ".lake", "secrets", "fixture"); const hostKey = join(dir, "host-key");
    for (const file of [key, hostKey]) {
      const generated = spawnSync("/usr/bin/ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", file]);
      assert.equal(generated.status, 0, "Synthetic SSH fixture key generation failed");
    }
    const probe = createServer(); await new Promise<void>(resolve => probe.listen(0, "127.0.0.1", resolve));
    const address = probe.address(); assert(address && typeof address !== "string"); const port = address.port;
    await new Promise<void>(resolve => probe.close(() => resolve()));
    const config = join(dir, "sshd.conf");
    writeFileSync(config, `Port ${port}\nListenAddress 127.0.0.1\nHostKey ${hostKey}\nPidFile ${dir}/sshd.pid\nAuthorizedKeysFile ${key}.pub\nStrictModes no\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nUsePAM no\nLogLevel ERROR\n`, { mode: 0o600 });
    sshd = spawn("/usr/sbin/sshd", ["-D", "-e", "-f", config], { stdio: ["ignore", "ignore", "pipe"] });
    let errors = ""; sshd.stderr!.on("data", chunk => { errors += chunk.toString(); });
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(sshd.exitCode, null, `Synthetic sshd failed: ${errors}`);
    // Read public host material only; private key contents remain inside OpenSSH.
    const publicHost = readFileSync(`${hostKey}.pub`, "utf8").trim().split(" ").slice(0, 2).join(" ");
    const knownHosts = join(dir, ".ssh", "known_hosts");
    writeFileSync(knownHosts, `[127.0.0.1]:${port} ${publicHost}\n`, { mode: 0o600 });
    store = new Store(join(dir, "data")); service = new TerminalService(store);
    const project = store.createProject("SSH fixture");
    const resource = store.createSshResource(project.id, "remote fixture", { host: "127.0.0.1", port, username: userInfo().username, identityFile: key });
    const session = store.createSession(project.id, "remote shell", [resource.id]);
    const terminal = await service.open(session.id, resource.id);
    const first = await service.execute(session.id, terminal.id, "user", "cd /tmp; export LAKE_REMOTE_FIXTURE=remote-state");
    assert.equal((await service.wait(session.id, terminal.id, first.id)).exitCode, 0);
    const second = await service.execute(session.id, terminal.id, "user", 'printf "$LAKE_REMOTE_FIXTURE:"; pwd');
    const result = await service.wait(session.id, terminal.id, second.id);
    assert.equal(result.exitCode, 0); assert.match(result.output, /remote-state:\/tmp/);
    service.close(session.id, terminal.id);
    writeFileSync(knownHosts, "", { mode: 0o600 });
    await assert.rejects(service.open(session.id, resource.id), /Terminal connection failed/);
    assert.equal(store.snapshot(session.id).terminals.at(-1)!.status, "disconnected");
    assert.equal(store.snapshot(session.id).evidence.length, 0);
  } finally {
    service?.shutdown(); store?.close(); sshd?.kill("SIGTERM");
    if (sshd && sshd.exitCode === null) await new Promise(resolve => sshd!.once("exit", resolve));
    if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
    rmSync(dir, { recursive: true, force: true });
  }
});
