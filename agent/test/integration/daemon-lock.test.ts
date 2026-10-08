import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { testHome } from "../fixtures/home.js";
import { acquireDaemonLock } from "../../src/app/daemon-lock.js";
test("OS lock excludes another daemon and releases after owner closes", async (t) => {
  const h = await testHome();
  t.after(() => h.close());
  const path = join(h.agent, "daemon.lock");
  const held = await acquireDaemonLock(path);
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      `import {acquireDaemonLock} from './src/app/daemon-lock.ts';try{const lock=await acquireDaemonLock(${JSON.stringify(path)});await lock.release();process.exit(0)}catch{process.exit(7)}`,
    ],
    { cwd: process.cwd(), stdio: "ignore" },
  );
  assert.equal(await new Promise((r) => child.on("exit", r)), 7);
  await held.release();
  const again = await acquireDaemonLock(path);
  await again.release();
  const owner=spawn(process.execPath,['--import','tsx','--input-type=module','-e',`import {acquireDaemonLock} from './src/app/daemon-lock.ts';await acquireDaemonLock(${JSON.stringify(path)});process.stdout.write('ready');setInterval(()=>{},1000);`],{cwd:process.cwd(),stdio:['ignore','pipe','ignore']});
  await new Promise<void>(r=>owner.stdout.once('data',()=>r()));
  await assert.rejects(acquireDaemonLock(path));
  const exited=new Promise<void>(r=>owner.once('exit',()=>r()));owner.kill('SIGKILL');await exited;
  const afterKill=await acquireDaemonLock(path);await afterKill.release();
});
