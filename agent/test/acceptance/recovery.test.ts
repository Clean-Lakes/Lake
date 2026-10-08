import test from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { linuxApplication } from "../fixtures/linux-application.js";
import { createLakeApplication } from "../../src/app/application.js";
for (const point of ["before_external", "after_external", "after_observed"])
  test(`kill at ${point} reconciles persisted intent without replaying the write`, async (t) => {
    const h = await linuxApplication(undefined, false);
    let restored: Awaited<ReturnType<typeof createLakeApplication>> | undefined;
    t.after(async () => {
      await restored?.stop();
      await h.close();
    });
    await writeFile(
      join(h.home, "agent/config.json"),
      JSON.stringify(h.app.config),
      { mode: 0o600 },
    );
    const s = await h.createSession();
    const invoke = (
      capability: string,
      p: Record<string, unknown>,
      key: string,
    ) =>
      h.app.gateway.execute(
        {
          sessionId: s.id,
          taskId: s.rootTaskId,
          actor: s.id,
          capability,
          resourceId: h.sshId,
          parameters: p,
          callKey: key,
        },
        new AbortController().signal,
      );
    const read = await invoke(
        "ssh.read_config",
        { path: h.target.configPath },
        "read",
      ),
      hash = (read.data as any).execution.hash,
      content = JSON.stringify({
        message: "fixture-ok crash-change",
        healthy: true,
      });
    const proposal = await invoke(
      "ssh.propose_config",
      { path: h.target.configPath, expectedHash: hash, content },
      "proposal",
    );
    const waiting = await invoke(
      "ssh.replace_config",
      {
        path: h.target.configPath,
        expectedHash: hash,
        artifactId: (proposal.data as any).execution.artifactId,
        rollback: true,
      },
      "change",
    );
    const action = await h.app.store.get<any>("actions", waiting.actionId!);
    await h.app.approve(action.id, action.proposalDigest);
    assert.equal(
      (await h.app.store.get<any>("actions", action.id)).status,
      "queued",
    );
    await h.app.stop();
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        "test/fixtures/fault-injection.ts",
        h.home,
        action.id,
        point,
      ],
      { cwd: process.cwd(), stdio: "ignore" },
    );
    const signal = await new Promise<string | null>((resolve, reject) => {
      child.on("error", reject);
      child.on("exit", (_code, signal) => resolve(signal));
    });
    assert.equal(signal, "SIGKILL");
    restored = await createLakeApplication({ home: h.home, background: false });
    const result = await restored.store.get<any>("actions", action.id);
    assert.equal(
      result.status,
      point === "before_external" ? "failed" : "succeeded",
    );
    assert.equal(
      (await restored.store.list<any>("action_attempts")).filter(
        (a) => a.actionId === action.id,
      ).length,
      1,
    );
    const actual = await h.target.exec(["cat", h.target.configPath]);
    assert.equal(actual.includes("crash-change"), point !== "before_external");
    const again = await restored.store.get<any>("actions", action.id);
    assert.notEqual(again.status, "queued");
  });
