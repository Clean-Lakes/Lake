import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { inputReferences } from "../src/input-references.js";
import { Store } from "../src/store.js";
void test("context references stay scoped and command evidence comes from recorded state", () => {
 const dir=mkdtempSync(join(tmpdir(),"lake-refs-")), store=new Store(dir);
 try {const p=store.createProject("one"), other=store.createProject("other"), resource=store.catalog().resources.find(r=>r.projectId===p.id)!, outside=store.catalog().resources.find(r=>r.projectId===other.id)!;const session=store.createSession(p.id,"case",[resource.id]);
 const refs=inputReferences(store,session.id,[{kind:"file-local",asset_ref:resource.id,path:"/tmp/context.txt",output:"forged"}]);assert.equal(refs[0]!.runtime,"local");assert.equal(refs[0]!.output,undefined);assert.match(String(refs[0]!.file_ref),/^f_[a-f0-9]{16}$/);
 assert.throws(()=>inputReferences(store,session.id,[{kind:"file-local",asset_ref:outside.id,path:"/tmp/other"}]));
 assert.throws(()=>inputReferences(store,session.id,[{kind:"file-local",asset_ref:resource.id,path:"relative"}]));
 const terminal=store.createTerminal(session.id,resource.id);const entry=store.beginCommand(session.id,terminal.id,"user","uname");store.finishCommand(session.id,terminal.id,entry.id,"observed",0,false);
 const result=inputReferences(store,session.id,[{kind:"terminal-command-block",terminal_id:terminal.id,block_id:entry.id,output:"forged"}]);assert.equal(result[0]!.output,"observed");assert.equal(result[0]!.exitCode,0);
 } finally {store.close();rmSync(dir,{recursive:true,force:true});}
});
