#!/usr/bin/env node
// Build only the upstream CLI graph; Lake keeps its Wails/React frontend.
import { spawn } from 'node:child_process';
import { access, cp, mkdir, realpath, readdir, rm, writeFile, chmod } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.versions.node !== '24.14.0') throw new Error('Use npm exec --yes --package=node@24.14.0 -- node scripts/build_zcode_agent.mjs');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'third_party/zcode');
const cli = join(source, 'apps/zcode-cli/packages/cli');
const output = join(root, 'bin/zcode');
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

async function run(args, cwd = source) {
  await new Promise((resolve, reject) => {
    const child = spawn(pnpm, args, { cwd, stdio: 'inherit', env: { ...process.env, NODE_ENV: 'development' }, shell: process.platform === 'win32' });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(`ZCode build exited ${code}`)));
  });
}
await run(['install', '--filter', 'zcode', '--filter', 'zcode-cli', '--filter', '@zcode/cli...', '--prod=false', '--frozen-lockfile', '--ignore-scripts']);
// Match the CLI build graph without compiling ZCode's Desktop/Web applications.
for (const name of ['shared-types', 'contracts', 'dynamic-workflow', 'dynamic-workflow-runtime', 'telemetry', 'i18n', 'core', 'adapters', 'tui', 'bootstrap', 'lake', 'cli']) {
  await run(['--filter', `@zcode/${name}`, 'run', 'build']);
}
await run(['exec', 'tsx', 'build-remote.ts'], join(source, 'packages/server'));
await mkdir(output, { recursive: true });
// Only the source-built remote bundle and its notices are runtime assets.
// Never carry stale TypeScript outputs or synced placeholder copies into the app.
await rm(join(output, 'remote'), { recursive: true, force: true });
await mkdir(join(output, 'remote'), { recursive: true });
for (const name of ['zcode-server.cjs', 'THIRD-PARTY-NOTICES.md']) {
  await cp(join(source, 'packages/server/dist/remote', name), join(output, 'remote', name));
}
await cp(join(cli, 'dist/zcode.cjs'), join(output, 'zcode.cjs'));
await cp(join(cli, 'dist/provider/zcode-builtin.json'), join(output, 'builtin.json'));
await cp(process.execPath, join(output, process.platform === 'win32' ? 'node.exe' : 'node'));
if (process.platform !== 'win32') await chmod(join(output, 'node'), 0o755);
// The pinned npm Node distribution carries Node and bundled dependency notices.
const nodePackage = dirname(dirname(await realpath(process.execPath)));
const nodeDependencies = join(nodePackage, 'node_modules');
const licenseCandidates = [join(nodePackage, 'LICENSE')];
for (const name of await readdir(nodeDependencies)) {
  if (/^node-(bin-)?(darwin|linux|win)/.test(name)) licenseCandidates.push(join(nodeDependencies, name, 'LICENSE'));
}
let nodeLicense;
for (const path of licenseCandidates) {
  try { await access(path); nodeLicense = path; break; } catch {}
}
if (!nodeLicense) throw new Error('Pinned Node distribution is missing its LICENSE');
await cp(nodeLicense, join(output, 'NODE-LICENSE'));

async function copyPackage(name) {
  let directory;
  try { directory = await realpath(join(source, "packages/services/node_modules", name)); } catch {}
  for (let base = cli; ; base = dirname(base)) {
    if (directory) break;
    try { directory = await realpath(join(base, 'node_modules', name)); break; }
    catch { if (base === source) throw new Error(`Cannot locate runtime dependency ${name}`); }
  }
  const destination = join(output, 'node_modules', name);
  await rm(destination, { recursive: true, force: true });
  await cp(directory, destination, { recursive: true, dereference: true, filter: path => !path.endsWith('.map') && !path.includes(`${join(directory, 'node_modules')}`) });
}
for (const name of ['playwright-core', 'koffi', 'node-pty', '@zcode/tui', 'typescript', 'ssh2', 'asn1', 'safer-buffer', 'bcrypt-pbkdf', 'tweetnacl']) await copyPackage(name);
for (const name of (await readdir(join(source, 'apps/zcode-cli/packages'))).filter(name => name.endsWith('-plugin') || ['bundled-skills', 'node-repl-host'].includes(name))) {
  const destination = join(output, 'packages', name);
  await rm(destination, { recursive: true, force: true });
  await cp(join(source, 'apps/zcode-cli/packages', name), destination, { recursive: true, dereference: true, filter: path => !path.includes('/node_modules') && !path.endsWith('.map') });
}
for (const name of ['LICENSE', 'NOTICE.md', 'THIRD-PARTY-NOTICES.md']) await cp(join(source, name), join(output, name));
await writeFile(join(output, 'runtime.json'), JSON.stringify({ source: 'https://github.com/zai-org/ZCode', commit: '29628c9acdb81b703bbd4080c207a0e7ce5e276e', node: process.versions.node, cli: '0.16.9', frontend: 'Lake Wails/React' }, null, 2));
console.log('Built source Agent in bin/zcode');
