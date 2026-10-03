// Verify the packaged Agent's storage handshake and external dependency closure.
// No model requests, Keychain access, real hosts or user data are involved.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';
import { Worker } from 'node:worker_threads';

const app = resolve(process.argv[2]);
const root = await mkdtemp(join(tmpdir(), 'lake-packaged-runtime-'));
let worker;
try {
  for (const directory of ['glm', 'lake-runtime']) {
    const provider = JSON.parse(await readFile(join(app, 'Contents/Resources', directory, 'provider/zcode-builtin.json'), 'utf8'));
    assert.ok(provider && typeof provider === 'object');
  }
  if (!process.versions.electron) {
    await import(pathToFileURL(join(app, 'Contents/Resources/lake-runtime/node_modules/@zcode/tui/dist/index.js')).href);
  }
  const home = join(root, 'home');
  await mkdir(join(home, '.zcode'), { recursive: true });
  await writeFile(join(home, '.zcode/sentinel'), 'upstream-untouched');
  await new Promise((accept, reject) => {
    worker = new Worker(join(app, 'Contents/Resources/glm/zcode.cjs'), {
      argv: ['app-server', '--stdio', '--prepare-storage', '--cwd', root],
      env: { ...process.env, HOME: home, LAKE_HOME: join(root, 'lake'), ELECTRON_RUN_AS_NODE: '1' },
      stdin: true, stdout: true, stderr: true,
    });
    let prepared = false;
    let failure;
    const timer = setTimeout(() => { failure = new Error('Packaged storage handshake timed out'); void worker.terminate(); }, 30_000);
    worker.stderr.resume();
    createInterface({ input: worker.stdout }).on('line', line => {
      try {
        assert.ok(line.length <= 65536);
        const frame = JSON.parse(line);
        if (frame.method === 'startup/storagePath') {
          assert.equal(frame.params.path, join(root, 'lake/cli/db/db.sqlite'));
          worker.stdin.write(JSON.stringify({ method: 'startup/storagePathReady', reuse: false }) + '\n');
        } else if (frame.method === 'startup/storagePrepared') {
          prepared = true; worker.stdin.end();
        } else if (frame.params?.phase === 'failed') throw new Error('Packaged storage preparation failed');
      } catch (error) { failure = error; void worker.terminate(); }
    });
    worker.once('error', error => { failure = error; });
    worker.once('exit', code => {
      clearTimeout(timer);
      if (failure || code !== 0 || !prepared) reject(failure || new Error('Packaged Agent exited before storage was prepared'));
      else accept();
    });
  });
  if (process.versions.electron) {
    await new Promise((accept, reject) => {
      worker = new Worker(join(app, 'Contents/Resources/app.asar/out/scheduler/index.js'), {
        env: { ...process.env, HOME: home, LAKE_HOME: join(root, 'lake'), ELECTRON_RUN_AS_NODE: '1' },
        stdout: true, stderr: true,
      });
      let ready = false;
      const timer = setTimeout(() => { void worker.terminate(); reject(new Error('Packaged native Scheduler startup timed out')); }, 30_000);
      worker.stderr.resume();
      createInterface({ input: worker.stdout }).on('line', line => {
        if (line.includes('cron scheduler started')) { ready = true; void worker.terminate(); }
      });
      worker.once('error', reject);
      worker.once('exit', () => {
        clearTimeout(timer);
        if (ready) accept();
        else reject(new Error('Packaged native Scheduler exited before startup'));
      });
    });
  }
  assert.equal(await readFile(join(root, 'home/.zcode/sentinel'), 'utf8'), 'upstream-untouched');
  console.log('Packaged native runtime startup, provider assets and LAKE isolation passed.');
} finally { await worker?.terminate(); await rm(root, { recursive: true, force: true }); }
