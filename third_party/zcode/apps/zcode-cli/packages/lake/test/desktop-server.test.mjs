import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdtemp,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";

test("desktop NDJSON uses source TypeScript with one runtime, clean replies and denied credential mutation",{timeout:15000},async()=>{
 const root=await mkdtemp(join(tmpdir(),"lake-desktop-server-"));const child=spawn(process.execPath,[fileURLToPath(new URL("../../../../../../../bin/zcode/zcode.cjs",import.meta.url)),"lake","serve"],{env:{...process.env,LAKE_HOME:root},stdio:["pipe","pipe","pipe"]});
 const pending=new Map(),lines=createInterface({input:child.stdout});let invalid=false;const exit=once(child,"close");child.stderr.resume();
 lines.on("line",line=>{try{const value=JSON.parse(line);if(value.id) {pending.get(value.id)?.(value);pending.delete(value.id);}}catch{invalid=true;}});
 let seq=0;const call=(method,params)=>new Promise(resolve=>{const id=String(++seq);pending.set(id,resolve);child.stdin.write(JSON.stringify({id,method,params})+"\n");});
 try{
  assert.equal((await call("cli",{argv:["current","--json"]})).result,null);
  const lake=(await call("cli",{argv:["add","fixture","--json"]})).result;assert.equal(lake.name,"fixture");
  await call("cli",{argv:["use","fixture","--json"]});
  assert.equal((await call("cli",{argv:["current","--json"]})).result.id,lake.id);
  const conversation=(await call("cli",{argv:["conversation","create","fixture","--json"]})).result;
  assert.equal((await call("conversation.start",{id:conversation.id})).error,undefined);
  assert.equal((await call("native.subagents",{id:conversation.id})).result.length,0);
  assert.match((await call("settings",{action:"model_save",api_key:"synthetic-denied-key"})).error,/本地/);
  assert.match((await call("unregistered.method",{})).error,/公开接口/);
  assert.equal(invalid,false);
 }finally{child.stdin.end();const timer=setTimeout(()=>child.kill("SIGKILL"),2000);await exit;clearTimeout(timer);lines.close();await rm(root,{recursive:true,force:true});}
});
