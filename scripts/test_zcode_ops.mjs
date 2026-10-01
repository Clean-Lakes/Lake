#!/usr/bin/env node
// Source-built native Agent -> scoped Lake MCP -> fixture approval -> history/journal.
import { spawn } from 'node:child_process';
import { dirname,resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
if(process.argv.length>2) throw new Error('This regression uses synthetic fixtures only; no production targets.');
const child=spawn(resolve(root,'bin/zcode/node'),['--test','test/conversation.test.mjs','test/operations.test.mjs'],{cwd:resolve(root,'third_party/zcode/apps/zcode-cli/packages/lake'),stdio:'inherit'});
child.on('error',()=>process.exit(1));child.on('exit',code=>process.exit(code ?? 1));
