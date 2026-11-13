import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,mkdir,realpath,symlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {discoverCodexRuntime,validateCodexNode} from './acp/runtime-paths';

test('Codex runtime discovery skips unsupported Node and resolves the matching npm without a shell',{skip:process.platform==='win32'},async()=>{
 const home=await mkdtemp(join(tmpdir(),'lake-runtime-discovery-')),old=join(home,'old'),valid=join(home,'valid');
 await mkdir(old);await mkdir(valid);await writeFile(join(old,'node'),'#!/bin/sh\necho v18.20.0\n',{mode:0o700});
 await symlink(process.execPath,join(valid,'node'));await writeFile(join(valid,'npm'),'// isolated npm path fixture');
 const result=await discoverCodexRuntime(undefined,undefined,{home,path:old+':'+valid,standardDirs:[],nodeExecutable:''});
 assert.equal(result.npmPath,await realpath(join(valid,'npm')));assert.equal(result.nodePath,await validateCodexNode(process.execPath));
});
test('Codex runtime discovery does not treat the current project as an executable search path',async()=>{
 const home=await mkdtemp(join(tmpdir(),'lake-no-runtime-'));
 await assert.rejects(discoverCodexRuntime(undefined,undefined,{home,path:'.',standardDirs:[],nodeExecutable:''}),/未找到可用/);
});
