import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const runtime = fileURLToPath(new URL('../../../../../../../bin/zcode/', import.meta.url));
test('native CLI and data worker isolate LAKE roots and reject the retired runner', { timeout: 20000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'lake-native-isolation-'));
  const home = join(root, 'home'), lakeHome = join(root, 'independent-lake');
  await mkdir(join(home, '.zcode'), { recursive: true });
  const sentinel = join(home, '.zcode', 'sentinel');
  await writeFile(sentinel, 'original-ZCode-untouched');
  const before = await stat(sentinel);
  const guard = join(root, 'fs-guard.cjs');
  await writeFile(guard, `const fs=require('node:fs');const p=require('node:fs/promises');
function protect(fn){return function(...args){for(const value of args.slice(0,2)){if(typeof value==='string'&&/(^|[\\\\/])\\.zcode([\\\\/]|$)/.test(value))throw Error('Original ZCode filesystem access denied');}return fn.apply(this,args);};}
for(const api of [fs,p])for(const name of ['readFile','readFileSync','writeFile','writeFileSync','appendFile','appendFileSync','open','openSync','readdir','readdirSync','mkdir','mkdirSync','access','accessSync','stat','statSync','lstat','lstatSync','existsSync','rename','renameSync','unlink','unlinkSync'])if(typeof api[name]==='function')api[name]=protect(api[name]);
require('node:module').syncBuiltinESMExports();`);
  const env = { PATH: process.env.PATH, HOME: home, TMPDIR: process.env.TMPDIR || tmpdir(), LAKE_HOME: lakeHome, ZCODE_MODEL_TELEMETRY_ENABLED: 'false' };
  const run = (entry, args, input = '') => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--require', guard, join(runtime, entry), ...args], { env, cwd: root, stdio: ['pipe','pipe','pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => stdout += chunk); child.stderr.on('data', chunk => stderr += chunk);
    const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Isolated native fixture timed out')); }, 15000);
    child.on('error', reject); child.on('close', code => { clearTimeout(timeout); resolve({ code, stdout, stderr }); }); child.stdin.end(input);
  });
  try {
    const help = await run('zcode.cjs', ['--help']);
    assert.equal(help.code, 0, help.stderr); assert.match(help.stdout, /Usage|用法/);
    const retired = await run('zcode.cjs', ['lake', 'serve']);
    assert.equal(retired.code, 2); assert.match(retired.stderr, /停用/);
    const added = await run('lake-data.cjs', ['--rpc'], JSON.stringify({id:1,params:{action:'lake.add',name:'isolated'}})+'\n');
    assert.equal(added.code, 0, added.stderr); assert.equal(JSON.parse(added.stdout).result.name, 'isolated');
    const invalid = await run('lake-data.cjs', ['--rpc'], JSON.stringify({id:1,params:{action:'overview',privateKey:'synthetic-rejected'}})+'\n');
    assert.equal(invalid.code, 0); assert.equal(JSON.parse(invalid.stdout).result, undefined); assert(JSON.parse(invalid.stdout).error);
    assert(!invalid.stdout.includes('synthetic-rejected'));
    assert.equal((await stat(join(lakeHome,'lake.db'))).mode & 0o777, 0o600);
    assert.equal(await readFile(sentinel,'utf8'),'original-ZCode-untouched');
    assert.equal((await stat(sentinel)).mtimeMs,before.mtimeMs);
  } finally { await rm(root,{recursive:true,force:true}); }
});
